/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import * as fs from 'fs';
import { Container } from 'inversify';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import 'reflect-metadata';
import { DebugAdapter } from './adapter/debugAdapter';
import { Binder, IBinderDelegate } from './binder';
import { ILogger } from './common/logging';
import { ProxyLogger } from './common/logging/proxyLogger';
import { getDeferred, IDeferred } from './common/promiseUtil';
import { AnyResolvingConfiguration } from './configuration';
import Dap from './dap/api';
import DapConnection from './dap/connection';
import { StreamDapTransport } from './dap/transport';
import { createGlobalContainer, createTopLevelSessionContainer } from './ioc';
import { IInitializeParams } from './ioc-extras';
import { TargetOrigin } from './targets/targetOrigin';
import { ITarget } from './targets/targets';

if (process.env.L10N_FSPATH_TO_BUNDLE) {
  l10n.config({ fsPath: process.env.L10N_FSPATH_TO_BUNDLE });
}

const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-js-debug-'));

interface IInitializationCollection {
  setExceptionBreakpointsParams?: Dap.SetExceptionBreakpointsParams;
  setBreakpointsParams: { params: Dap.SetBreakpointsParams; ids: number[] }[];
  customBreakpoints: string[];
  xhrBreakpoints: string[];
  initializeParams: Dap.InitializeParams;
  launchParams: AnyResolvingConfiguration;

  /** Promise that should be resolved when the launch is finished */
  deferred: IDeferred<Dap.LaunchResult | Dap.AttachResult>;
}

/**
 * 'Collects' DAP calls made until the launch/attach request comes in, and
 * returns a promise for the DA to resolve when the launch is processed.
 *
 * This is needed since until the 'launch' comes in, we don't know what session
 * the incoming connection refers to.
 */
function collectInitialize(dap: Dap.Api) {
  let setExceptionBreakpointsParams: Dap.SetExceptionBreakpointsParams | undefined;
  const setBreakpointsParams: { params: Dap.SetBreakpointsParams; ids: number[] }[] = [];
  let customBreakpoints: string[] = [];
  let xhrBreakpoints: string[] = [];
  const configurationDone = getDeferred<void>();
  let lastBreakpointId = 0;
  let initializeParams: Dap.InitializeParams;

  dap.on('setBreakpoints', async params => {
    const ids = params.breakpoints?.map(() => ++lastBreakpointId) ?? [];
    setBreakpointsParams.push({ params, ids });
    const breakpoints = ids.map(id => ({
      id,
      verified: false,
      message: l10n.t('breakpoint.provisionalBreakpoint', `Unbound breakpoint`),
    })); // TODO: Put a useful message here
    return { breakpoints };
  });

  dap.on('setExceptionBreakpoints', async params => {
    setExceptionBreakpointsParams = params;
    return {};
  });

  dap.on('setCustomBreakpoints', async params => {
    customBreakpoints = params.ids;
    xhrBreakpoints = params.xhr;
    return {};
  });

  dap.on('configurationDone', async () => {
    configurationDone.resolve();
    return {};
  });

  dap.on('threads', async () => {
    return { threads: [] };
  });

  dap.on('loadedSources', async () => {
    return { sources: [] };
  });

  dap.on('initialize', async params => {
    initializeParams = params;
    setTimeout(() => dap.initialized({}), 0);
    return DebugAdapter.capabilities();
  });

  return new Promise<IInitializationCollection>(resolve => {
    const handle = async (
      launchParams: Dap.LaunchParams | Dap.AttachParams,
    ): Promise<Dap.LaunchResult | Dap.AttachResult> => {
      // By spec, clients should not call launch until after ConfigurationDone...
      // but VS Code doesn't actually do this, and breakpoints aren't sent
      // until ConfigurationDone happens, so make sure to wait on it.
      await configurationDone.promise;

      const deferred = getDeferred<Dap.LaunchResult | Dap.AttachResult>();
      if (!initializeParams) {
        throw new Error(`cannot call launch/attach before initialize`);
      }

      resolve({
        initializeParams,
        setExceptionBreakpointsParams,
        setBreakpointsParams,
        customBreakpoints,
        xhrBreakpoints,
        launchParams: launchParams as AnyResolvingConfiguration,
        deferred,
      });

      return deferred.promise;
    };
    dap.on('launch', p => handle(p));
    dap.on('attach', handle);
  });
}

interface ISessionInfo extends IInitializationCollection {
  connection: DapConnection;
}

class DapSessionManager implements IBinderDelegate {
  private readonly sessions = new Map<string, IDeferred<ISessionInfo>>();

  constructor(private readonly dapRoot: Dap.Api, public readonly services: Container) {}

  /** @inheritdoc */
  public async acquireDap(target: ITarget): Promise<DapConnection> {
    const existing = this.sessions.get(target.id());
    if (existing) {
      const { connection } = await existing.promise;
      return connection;
    }

    const parent = target.parent();
    let dap: Dap.Api;
    if (parent) {
      const parentCnx = this.sessions.get(parent.id())?.settledValue;
      if (!parentCnx) {
        throw new Error('Expected parent session to have a settled value');
      }
      dap = parentCnx.connection.dap();
    } else {
      dap = this.dapRoot;
    }

    const deferred = getDeferred<ISessionInfo>();
    this.sessions.set(target.id(), deferred);

    // don't await on this, otherwise we deadlock since the promise may not
    // resolve until launch is finished, which requires returning from this method
    dap
      .startDebuggingRequest({
        request: target.launchConfig.request,
        configuration: {
          type: target.launchConfig.type,
          name: target.name(),
          __pendingTargetId: target.id(),
        },
      })
      .catch(e => deferred.reject(e));

    return deferred.promise.then(d => d.connection);
  }

  /** @inheritdoc */
  public async initAdapter(adapter: DebugAdapter, target: ITarget): Promise<boolean> {
    const init = this.sessions.get(target.id())?.settledValue;
    if (!init) {
      throw new Error(`Expected to find pending init for target ${target.id()}`);
    }

    if (init.setExceptionBreakpointsParams) {
      await adapter.setExceptionBreakpoints(init.setExceptionBreakpointsParams);
    }
    for (const { params, ids } of init.setBreakpointsParams) {
      await adapter.breakpointManager.setBreakpoints(params, ids);
    }
    await adapter.setCustomBreakpoints({
      xhr: init.xhrBreakpoints,
      ids: init.customBreakpoints,
    });
    await adapter.onInitialize(init.initializeParams);
    await adapter.configurationDone();

    await adapter.launchBlocker();
    init.deferred.resolve({});

    return true;
  }

  /** @inheritdoc */
  public releaseDap(target: ITarget): void {
    this.sessions.delete(target.id());
  }

  /** Gets whether the manager is waiting for a target of the given ID */
  public hasPendingTarget(targetId: string) {
    return this.sessions.get(targetId)?.hasSettled() === false;
  }

  /** Processes an incoming connection. */
  public handleConnection(info: ISessionInfo) {
    if (!('__pendingTargetId' in info.launchParams) || !info.launchParams.__pendingTargetId) {
      throw new Error(`Incoming session is missing __pendingTargetId`);
    }

    const targetId = info.launchParams.__pendingTargetId;
    const session = this.sessions.get(targetId);
    if (!session) {
      throw new Error(`__pendingTargetId ${targetId} not found`);
    }

    session.resolve(info);
  }
}

function startDebugServer(options: net.ListenOptions) {
  const services = createGlobalContainer({ storagePath, isVsCode: false });
  const managers = new Set<DapSessionManager>();

  const server = net
    .createServer(async socket => {
      try {
        const logger = new ProxyLogger();
        const transport = new StreamDapTransport(socket, socket, logger);
        const connection = new DapConnection(transport, logger);
        const dap = connection.dap();

        const initialized = await collectInitialize(dap);
        if ('__pendingTargetId' in initialized.launchParams) {
          const ptId = initialized.launchParams.__pendingTargetId;
          const manager = ptId && [...managers].find(m => m.hasPendingTarget(ptId));
          if (!manager) {
            throw new Error(`Cannot find pending target for ${ptId}`);
          }
          logger.connectTo(manager.services.get(ILogger));
          manager.handleConnection({ ...initialized, connection });
        } else {
          const sessionServices = createTopLevelSessionContainer(services);
          const manager = new DapSessionManager(dap, sessionServices);
          managers.add(manager);
          sessionServices.bind(IInitializeParams).toConstantValue(initialized.initializeParams);
          logger.connectTo(sessionServices.get(ILogger));
          const binder = new Binder(
            manager,
            connection,
            sessionServices,
            new TargetOrigin('targetOrigin'),
          );
          transport.closed(() => {
            binder.dispose();
            managers.delete(manager);
          });
          initialized.deferred.resolve(await binder.boot(initialized.launchParams, dap));
        }
      } catch (e) {
        console.error(e);
        return socket.destroy();
      }
    })
    .on('error', err => {
      console.error(err);
      process.exit(1);
    })
    .listen(options, () => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const addr = server.address()!;
      console.log(
        `Debug server listening at ${
          typeof addr === 'string' ? addr : `${addr.address}:${addr.port}`
        }`,
      );
    });
}

const [, argv1, portOrSocket = '8123', host = 'localhost'] = process.argv;

if (process.argv.includes('--help')) {
  console.log(`Usage: ${path.basename(argv1)} [port|socket path=8123] [host=localhost]`);
} else if (!isNaN(Number(portOrSocket))) {
  startDebugServer({ port: Number(portOrSocket), host });
} else {
  startDebugServer({ path: portOrSocket });
}
