// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Binder, BinderDelegate } from './binder';
import DapConnection from './dap/connection';
import { NodeLauncher } from './targets/node/nodeLauncher';
import { BrowserLauncher } from './targets/browser/browserLauncher';
import { BrowserAttacher } from './targets/browser/browserAttacher';
import { Target } from './targets/targets';
import { DebugAdapter } from './adapter/debugAdapter';
import Dap from './dap/api';
import { generateBreakpointIds } from './adapter/breakpoints';
import { ChildProcessProgramLauncher } from './targets/node/childProcessProgramLauncher';

const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'pwa-debugger-'));

class Configurator {
  private _setExceptionBreakpointsParams?: Dap.SetExceptionBreakpointsParams;
  private _setBreakpointsParams: {params: Dap.SetBreakpointsParams, ids: number[]}[];
  private _customBreakpoints = new Set<string>();

  constructor(dapPromise: Promise<Dap.Api>) {
    this._setBreakpointsParams = [];
    dapPromise.then(dap => this._listen(dap));
  }

  _listen(dap: Dap.Api) {
    dap.on('setBreakpoints', async params => {
      const ids = generateBreakpointIds(params);
      this._setBreakpointsParams.push({params, ids});
      const breakpoints = ids.map(id => ({ id, verified: false }));
      return { breakpoints };
    });

    dap.on('setExceptionBreakpoints', async params => {
      this._setExceptionBreakpointsParams = params;
      return {};
    });

    dap.on('enableCustomBreakpoints', async params => {
      for (const id of params.ids)
        this._customBreakpoints.add(id);
      return {};
    });

    dap.on('disableCustomBreakpoints', async params => {
      for (const id of params.ids)
        this._customBreakpoints.delete(id);
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
    for (const {params, ids} of this._setBreakpointsParams)
      await adapter.breakpointManager.setBreakpoints(params, ids);
    await adapter.enableCustomBreakpoints({ ids: Array.from(this._customBreakpoints) });
    await adapter.configurationDone({});
  }
}

const server = net.createServer(async socket => {
  const launchers = [
    new NodeLauncher(new ChildProcessProgramLauncher()),
    new BrowserLauncher(storagePath),
    new BrowserAttacher(),
  ];

  const binderDelegate: BinderDelegate = {
    async acquireDap(target: Target): Promise<DapConnection> {
      // Note: we can make multi-session work through custom dap message:
      // - spin up a separate server for this session;
      // - ask ui part to create a session for us and connect to the port;
      // - marshall target name changes across.
      return connection;
    },

    async initAdapter(debugAdapter: DebugAdapter, target: Target): Promise<boolean> {
      await configurator.configure(debugAdapter);
      return true;
    },

    releaseDap(target: Target): void {
    }
  };

  const connection = new DapConnection();
  new Binder(binderDelegate, connection, launchers, 'targetOrigin');
  const configurator = new Configurator(connection.dap());

  connection.init(socket, socket);
}).listen(process.argv.length >= 3 ? +process.argv[2] : 0);
console.log(`Listening at ${server.address().port}`);
