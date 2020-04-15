/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { createGlobalContainer, createTopLevelSessionContainer } from './ioc';

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import { Binder, IBinderDelegate } from './binder';
import DapConnection from './dap/connection';
import { DebugAdapter } from './adapter/debugAdapter';
import Dap from './dap/api';
import { IDisposable } from './common/disposable';
import * as nls from 'vscode-nls';
import { TargetOrigin } from './targets/targetOrigin';
import { ILogger } from './common/logging';
import { StreamDapTransport } from './dap/transport';

const localize = nls.loadMessageBundle();

const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-js-debug-'));

class Configurator {
  private _setExceptionBreakpointsParams?: Dap.SetExceptionBreakpointsParams;
  private _setBreakpointsParams: { params: Dap.SetBreakpointsParams; ids: number[] }[];
  private _customBreakpoints = new Set<string>();
  private lastBreakpointId = 0;

  constructor(dapPromise: Promise<Dap.Api>) {
    this._setBreakpointsParams = [];
    dapPromise.then(dap => this._listen(dap));
  }

  _listen(dap: Dap.Api) {
    dap.on('setBreakpoints', async params => {
      const ids = params.breakpoints?.map(() => ++this.lastBreakpointId) ?? [];
      this._setBreakpointsParams.push({ params, ids });
      const breakpoints = ids.map(id => ({
        id,
        verified: false,
        message: localize('breakpoint.provisionalBreakpoint', `Unbound breakpoint`),
      })); // TODO: Put a useful message here
      return { breakpoints };
    });

    dap.on('setExceptionBreakpoints', async params => {
      this._setExceptionBreakpointsParams = params;
      return {};
    });

    dap.on('enableCustomBreakpoints', async params => {
      for (const id of params.ids) this._customBreakpoints.add(id);
      return {};
    });

    dap.on('disableCustomBreakpoints', async params => {
      for (const id of params.ids) this._customBreakpoints.delete(id);
      return {};
    });

    dap.on('configurationDone', async () => {
      return {};
    });

    dap.on('threads', async () => {
      return { threads: [] };
    });

    dap.on('loadedSources', async () => {
      return { sources: [] };
    });
  }

  async configure(adapter: DebugAdapter) {
    if (this._setExceptionBreakpointsParams)
      await adapter.setExceptionBreakpoints(this._setExceptionBreakpointsParams);
    for (const { params, ids } of this._setBreakpointsParams)
      await adapter.breakpointManager.setBreakpoints(params, ids);
    await adapter.enableCustomBreakpoints({ ids: Array.from(this._customBreakpoints) });
    await adapter.configurationDone();
  }
}

export function startDebugServer(port: number): Promise<IDisposable> {
  return new Promise((resolve, reject) => {
    const server = net
      .createServer(async socket => {
        const services = createTopLevelSessionContainer(
          createGlobalContainer({ storagePath, isVsCode: false }),
        );
        const binderDelegate: IBinderDelegate = {
          async acquireDap(): Promise<DapConnection> {
            // Note: we can make multi-session work through custom dap message:
            // - spin up a separate server for this session;
            // - ask ui part to create a session for us and connect to the port;
            // - marshall target name changes across.
            return connection;
          },

          async initAdapter(debugAdapter: DebugAdapter): Promise<boolean> {
            await configurator.configure(debugAdapter);
            return true;
          },

          releaseDap(): void {
            // no-op
          },
        };

        const transport = new StreamDapTransport(socket, socket, services.get(ILogger));
        const connection = new DapConnection(transport, services.get(ILogger));
        new Binder(binderDelegate, connection, services, new TargetOrigin('targetOrigin'));
        const configurator = new Configurator(connection.dap());
      })
      .on('error', reject)
      .listen(port, () => {
        console.log(`Debug server listening at ${(server.address() as net.AddressInfo).port}`);
        resolve({
          dispose: () => {
            server.close();
          },
        });
      });
  });
}
