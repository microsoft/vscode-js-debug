/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { CancellationToken } from 'vscode';
import * as nls from 'vscode-nls';
import { generateBreakpointIds } from './adapter/breakpoints';
import { DebugAdapter } from './adapter/debugAdapter';
import { Thread } from './adapter/threads';
import { CancellationTokenSource, TaskCancelledError } from './common/cancellation';
import { IDisposable, EventEmitter } from './common/events';
import { LogTag, ILogger, resolveLoggerOptions } from './common/logging';
import * as urlUtils from './common/urlUtils';
import {
  AnyLaunchConfiguration,
  AnyResolvingConfiguration,
  applyDefaults,
  isNightly,
} from './configuration';
import Dap from './dap/api';
import DapConnection from './dap/connection';
import * as errors from './dap/errors';
import { ILauncher, ILaunchResult, ITarget } from './targets/targets';
import {
  filterErrorsReportedToTelemetry,
  installUnhandledErrorReporter,
} from './telemetry/unhandledErrorReporter';
import { ITargetOrigin } from './targets/targetOrigin';
import { IAsyncStackPolicy, getAsyncStackPolicy } from './adapter/asyncStackPolicy';
import { TelemetryReporter } from './telemetry/telemetryReporter';
import { mapValues } from './common/objUtils';
import * as os from 'os';
import { delay } from './common/promiseUtil';
import { Container } from 'inversify';
import { createTargetContainer, provideLaunchParams } from './ioc';
import { disposeContainer } from './ioc-extras';

const localize = nls.loadMessageBundle();

// eslint-disable-next-line
const packageJson = require('../../package.json');

export interface IBinderDelegate {
  acquireDap(target: ITarget): Promise<DapConnection>;
  // Returns whether we should disable child session treatment.
  initAdapter(debugAdapter: DebugAdapter, target: ITarget, launcher: ILauncher): Promise<boolean>;
  releaseDap(target: ITarget): void;
}

export class Binder implements IDisposable {
  private _delegate: IBinderDelegate;
  private _disposables: IDisposable[];
  private _threads = new Map<ITarget, { thread: Thread; debugAdapter: DebugAdapter }>();
  private _launchers = new Set<ILauncher>();
  private _terminationCount = 0;
  private _onTargetListChangedEmitter = new EventEmitter<void>();
  readonly onTargetListChanged = this._onTargetListChangedEmitter.event;
  private _dap: Promise<Dap.Api>;
  private _targetOrigin: ITargetOrigin;
  private _launchParams?: AnyLaunchConfiguration;
  private _clientCapabilities: Dap.InitializeParams | undefined;
  private _asyncStackPolicy?: IAsyncStackPolicy;
  private _serviceTree = new WeakMap<ITarget, Container>();

  constructor(
    delegate: IBinderDelegate,
    connection: DapConnection,
    private readonly telemetryReporter: TelemetryReporter,
    private readonly _rootServices: Container,
    targetOrigin: ITargetOrigin,
  ) {
    this._launchers = new Set(_rootServices.getAll(ILauncher));
    this._delegate = delegate;
    this._dap = connection.dap();
    this._targetOrigin = targetOrigin;
    this._disposables = [
      this._onTargetListChangedEmitter,
      this.telemetryReporter,
      installUnhandledErrorReporter(_rootServices.get(ILogger), telemetryReporter),
    ];

    for (const launcher of this._launchers) {
      this._launchers.add(launcher);
      launcher.onTargetListChanged(
        () => {
          const targets = this.targetList();
          this._attachToNewTargets(targets, launcher);
          this._detachOrphanThreads(targets);
          this._onTargetListChangedEmitter.fire();
        },
        undefined,
        this._disposables,
      );
    }

    this._dap.then(dap => {
      dap.on('initialize', async clientCapabilities => {
        this._clientCapabilities = clientCapabilities;
        const capabilities = DebugAdapter.capabilities();
        if (clientCapabilities.clientID === 'vscode') {
          filterErrorsReportedToTelemetry();
        }

        setTimeout(() => {
          dap.initialized({});
        }, 0);
        return capabilities;
      });
      dap.on('setExceptionBreakpoints', async () => ({}));
      dap.on('setBreakpoints', async params => {
        return {
          breakpoints: generateBreakpointIds(params).map(id => ({
            id,
            verified: false,
            message: localize('breakpoint.provisionalBreakpoint', `Unbound breakpoint`),
          })),
        }; // TODO: Put a useful message here
      });
      dap.on('configurationDone', async () => ({}));
      dap.on('threads', async () => ({ threads: [] }));
      dap.on('loadedSources', async () => ({ sources: [] }));
      dap.on('breakpointLocations', () => Promise.resolve({ breakpoints: [] }));
      dap.on('attach', params =>
        this._boot(applyDefaults(params as AnyResolvingConfiguration), dap),
      );
      dap.on('launch', params =>
        this._boot(applyDefaults(params as AnyResolvingConfiguration), dap),
      );
      dap.on('terminate', async () => {
        await this._disconnect();
        return {};
      });
      dap.on('disconnect', async () => {
        await this._disconnect();
        return {};
      });
      dap.on('restart', async () => {
        await this._restart();
        return {};
      });
    });
  }

  private async _disconnect() {
    await Promise.all([...this._launchers].map(l => l.disconnect()));

    const didTerminate = () => !this.targetList.length && this._terminationCount === 0;
    if (didTerminate()) {
      return;
    }

    await new Promise(resolve =>
      this.onTargetListChanged(() => {
        if (didTerminate()) {
          resolve();
        }
      }),
    );

    await delay(0); // next task so that we're sure terminated() sent
  }

  private async _boot(params: AnyLaunchConfiguration, dap: Dap.Api) {
    warnNightly(dap);
    this.reportBootTelemetry(params);
    provideLaunchParams(this._rootServices, params);
    this._rootServices.get<ILogger>(ILogger).setup(resolveLoggerOptions(dap, params.trace));

    const cts =
      params.timeout > 0
        ? CancellationTokenSource.withTimeout(params.timeout)
        : new CancellationTokenSource();

    if (params.rootPath) params.rootPath = urlUtils.platformPathToPreferredCase(params.rootPath);
    this._launchParams = params;
    let results = await Promise.all(
      [...this._launchers].map(l => this._launch(l, params, cts.token)),
    );
    results = results.filter(result => !!result);
    if (results.length) return errors.createUserError(results.join('\n'));
    return {};
  }

  private reportBootTelemetry(rawParams: AnyLaunchConfiguration) {
    const defaults = (applyDefaults({
      type: rawParams.type,
      request: rawParams.request,
      name: '<string>',
    } as AnyResolvingConfiguration) as unknown) as { [key: string]: unknown };

    // Sanitization function that strips non-default strings from the launch
    // config, to avoid unnecessarily collecting information about the workspace.
    const sanitizer = (value: unknown, key?: string): unknown => {
      if (typeof value === 'string') {
        return key && defaults[key] === value ? value : `<string>`;
      }

      if (value instanceof Array) {
        return value.map(v => sanitizer(v));
      }

      if (value && typeof value === 'object') {
        return mapValues(value as { [key: string]: unknown }, v => sanitizer(v));
      }

      return value;
    };

    this.telemetryReporter.report('launch', {
      type: rawParams.type,
      request: rawParams.request,
      os: `${os.platform()} ${os.arch()}`,
      nodeVersion: process.version,
      adapterVersion: packageJson.version,
      parameters: mapValues((rawParams as unknown) as { [key: string]: unknown }, sanitizer),
    });
  }

  async _restart() {
    await Promise.all([...this._launchers].map(l => l.restart()));
  }

  async _launch(
    launcher: ILauncher,
    params: AnyLaunchConfiguration,
    cancellationToken: CancellationToken,
  ): Promise<string | undefined> {
    const result = await this.captureLaunch(launcher, params, cancellationToken);
    if (result.error) {
      return result.error;
    }

    if (!result.blockSessionTermination) {
      return;
    }

    ++this._terminationCount;
    launcher.onTerminated(
      result => {
        this._detachOrphanThreads(this.targetList(), { restart: result.restart });
        this._onTargetListChangedEmitter.fire();
        if (!--this._terminationCount) {
          this._dap.then(dap => dap.terminated({ restart: result.restart }));
        }
      },
      undefined,
      this._disposables,
    );
  }

  /**
   * Launches the debug target, returning any the resolved result. Does a
   * bunch of mangling to log things, catch uncaught errors,
   * and format timeouts correctly.
   */
  private async captureLaunch(
    launcher: ILauncher,
    params: AnyLaunchConfiguration,
    cancellationToken: CancellationToken,
  ): Promise<ILaunchResult> {
    const name = launcher.constructor.name;

    let result: ILaunchResult;
    try {
      result = await launcher.launch(
        params,
        {
          telemetryReporter: this.telemetryReporter,
          cancellationToken,
          targetOrigin: this._targetOrigin,
          dap: await this._dap,
        },
        this._clientCapabilities!,
      );
    } catch (e) {
      if (e instanceof TaskCancelledError) {
        result = {
          error: localize('errors.timeout', '{0}: timeout after {1}ms', e.message, params.timeout),
        };
      }

      result = { error: e.message };
    }

    if (result.error) {
      // Assume it was precipiated from some timeout, if we got an error after cancellation
      if (cancellationToken.isCancellationRequested) {
        result.error = localize(
          'errors.timeout',
          '{0}: timeout after {1}ms',
          result.error,
          params.timeout,
        );
      }

      this._rootServices.get<ILogger>(ILogger).warn(LogTag.RuntimeLaunch, 'Launch returned error', {
        error: result.error,
        name,
      });
    } else if (result.blockSessionTermination) {
      this._rootServices
        .get<ILogger>(ILogger)
        .info(LogTag.RuntimeLaunch, 'Launched successfully', { name });
    }

    return result;
  }

  dispose() {
    for (const disposable of this._disposables) disposable.dispose();
    this._disposables = [];
    for (const launcher of this._launchers) launcher.dispose();
    this._launchers.clear();
    disposeContainer(this._rootServices);
    this._detachOrphanThreads([]);
  }

  targetList(): ITarget[] {
    const result: ITarget[] = [];
    for (const delegate of this._launchers) result.push(...delegate.targetList());
    return result;
  }

  async attach(target: ITarget, launcher: ILauncher) {
    if (!target.canAttach()) return;
    const cdp = await target.attach();
    if (!cdp) return;
    const connection = await this._delegate.acquireDap(target);
    const dap = await connection.dap();
    const launchParams = this._launchParams!;

    if (!this._asyncStackPolicy) {
      this._asyncStackPolicy = getAsyncStackPolicy(launchParams.showAsyncStacks);
    }

    const parentTarget = target.parent();
    const parentContainer =
      (parentTarget && this._serviceTree.get(parentTarget)) || this._rootServices;
    const container = createTargetContainer(parentContainer, target, dap, cdp);
    this._serviceTree.set(target, parentContainer);

    // todo: move scriptskipper into services collection
    const debugAdapter = new DebugAdapter(
      dap,
      this._launchParams?.rootPath || undefined,
      target.sourcePathResolver(),
      this._asyncStackPolicy,
      launchParams,
      this.telemetryReporter,
      container,
    );
    const thread = debugAdapter.createThread(target.name(), cdp, target);
    this._threads.set(target, { thread, debugAdapter });
    const startThread = async () => {
      await debugAdapter.launchBlocker();
      cdp.Runtime.runIfWaitingForDebugger({});
      return {};
    };
    if (await this._delegate.initAdapter(debugAdapter, target, launcher)) {
      startThread();
    } else {
      dap.on('attach', startThread);
      dap.on('disconnect', async () => {
        this.telemetryReporter.flush();
        if (target.canStop()) target.stop();
        return {};
      });
      dap.on('terminate', async () => {
        if (target.canStop()) target.stop();
        return {};
      });
      dap.on('restart', async () => {
        if (target.canRestart()) target.restart();
        else await this._restart();
        return {};
      });
    }

    await target.afterBind();
  }

  async detach(target: ITarget) {
    if (!target.canDetach()) return;
    await target.detach();
    this._releaseTarget(target);
  }

  _attachToNewTargets(targets: ITarget[], launcher: ILauncher) {
    for (const target of targets.values()) {
      if (!target.waitingForDebugger()) {
        continue;
      }

      const thread = this._threads.get(target);
      if (!thread) {
        this.attach(target, launcher);
      }
    }
  }

  _detachOrphanThreads(targets: ITarget[], terminateArgs?: Dap.TerminatedEventParams) {
    const set = new Set(targets);
    for (const target of this._threads.keys()) {
      if (!set.has(target)) this._releaseTarget(target, terminateArgs);
    }
  }

  _releaseTarget(target: ITarget, terminateArgs: Dap.TerminatedEventParams = {}) {
    const data = this._threads.get(target);
    if (!data) return;
    this._threads.delete(target);
    data.thread.dispose();
    data.debugAdapter.dap.terminated(terminateArgs);
    data.debugAdapter.dispose();
    this._delegate.releaseDap(target);
  }
}

function warnNightly(dap: Dap.Api): void {
  if (isNightly()) {
    dap.output({
      category: 'console',
      output: `Note: Using the "preview" debug extension\n`,
    });
  }
}
