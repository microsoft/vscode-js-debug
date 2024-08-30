/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { DebugAdapter } from './adapter/debugAdapter';
import { Binder, IBinderDelegate } from './binder';
import { IDisposable } from './common/disposable';
import { ILogger } from './common/logging';
import Dap from './dap/api';
import DapConnection from './dap/connection';
import { StreamDapTransport } from './dap/transport';
import { createGlobalContainer, createTopLevelSessionContainer } from './ioc';
import { TargetOrigin } from './targets/targetOrigin';

const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-js-debug-'));

class Configurator {
  private _setExceptionBreakpointsParams?: Dap.SetExceptionBreakpointsParams;
  private _setBreakpointsParams: { params: Dap.SetBreakpointsParams; ids: number[] }[];
  private _customBreakpoints: string[] = [];
  private _xhrBreakpoints: string[] = [];
  private lastBreakpointId = 0;

  constructor(dap: Dap.Api) {
    this._setBreakpointsParams = [];
    this._listen(dap);
  }

  _listen(dap: Dap.Api) {
    dap.on('setBreakpoints', async params => {
      const ids = params.breakpoints?.map(() => ++this.lastBreakpointId) ?? [];
      this._setBreakpointsParams.push({ params, ids });
      const breakpoints = ids.map(id => ({
        id,
        verified: false,
        message: l10n.t('Unbound breakpoint'),
      })); // TODO: Put a useful message here
      return { breakpoints };
    });

    dap.on('setExceptionBreakpoints', async params => {
      this._setExceptionBreakpointsParams = params;
      return {};
    });

    dap.on('setCustomBreakpoints', async params => {
      this._customBreakpoints = params.ids;
      this._xhrBreakpoints = params.xhr;
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
    if (this._setExceptionBreakpointsParams) {
      await adapter.setExceptionBreakpoints(this._setExceptionBreakpointsParams);
    }
    for (const { params, ids } of this._setBreakpointsParams) {
      await adapter.breakpointManager.setBreakpoints(params, ids);
    }
    await adapter.setCustomBreakpoints({
      xhr: this._xhrBreakpoints,
      ids: this._customBreakpoints,
    });
    await adapter.configurationDone();
  }
}

export function startDebugServer(port: number, host?: string): Promise<IDisposable> {
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
      .listen({ port, host }, () => {
        console.log(`Debug server listening at ${(server.address() as net.AddressInfo).port}`);
        resolve({
          dispose: () => {
            server.close();
          },
        });
      });
  });
}
