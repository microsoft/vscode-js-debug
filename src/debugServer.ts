// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Binder, BinderDelegate } from './binder';
import DapConnection from './dap/connection';
import { NodeLauncher, ProgramLauncher } from './targets/node/nodeLauncher';
import { BrowserLauncher } from './targets/browser/browserLauncher';
import { BrowserAttacher } from './targets/browser/browserAttacher';
import { EventEmitter } from './common/events';
import * as childProcess from 'child_process';
import { Target } from './targets/targets';
import { DebugAdapter } from './adapter/debugAdapter';
import Dap from './dap/api';
import { generateBreakpointIds } from './adapter/breakpoints';

const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'pwa-debugger-'));

class ChildProcessProgramLauncher implements ProgramLauncher {
  private _onProgramStoppedEmitter = new EventEmitter<void>();
  public onProgramStopped = this._onProgramStoppedEmitter.event;
  private _process?: childProcess.ChildProcess;
  private _stop: () => void;

  constructor() {
    this._stop = this.stopProgram.bind(this);
  }

  launchProgram(name: string, cwd: string | undefined, env: { [key: string]: string | null }, command: string): void {
    // TODO: implement this for Windows.
    const isWindows = process.platform === 'win32';
    if (process.platform !== 'linux' && process.platform !== 'darwin')
      return;

    let bash = '';
    try {
      bash = childProcess.execFileSync('which', ['bash'], { stdio: 'pipe' }).toString().split(/\r?\n/)[0];
    } catch (e) {
      return;
    }

    this._process = childProcess.spawn(
      bash,
      ["-c", command],
      {
        cwd,
        // On non-windows platforms, `detached: false` makes child process a leader of a new
        // process group, making it possible to kill child process tree with `.kill(-pid)` command.
        // @see https://nodejs.org/api/child_process.html#child_process_options_detached
        detached: !isWindows,
        env
      }
    );
    process.on('exit', this._stop);
    if (this._process.pid === undefined)
      this.stopProgram();
  }

  stopProgram() {
    if (!this._process)
      return;
    process.removeListener('exit', this._stop);
    if (this._process.pid && !this._process.killed) {
      // Force kill browser.
      try {
        if (process.platform === 'win32')
          childProcess.execSync(`taskkill /pid ${this._process.pid} /T /F`);
        else
          process.kill(-this._process.pid, 'SIGKILL');
      } catch (e) {
        // the process might have already stopped
      }
    }
    this._process = undefined;
  }

  dispose() {
    this.stopProgram();
  }
}

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
