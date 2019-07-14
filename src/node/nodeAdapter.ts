/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Dap from '../dap/api';
import CdpConnection from '../cdp/connection';
import { Adapter } from '../adapter/adapter';

import { spawn } from 'child_process';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as which from 'which';
import * as errors from '../adapter/errors';
import { WebSocketTransport } from '../cdp/transport';
import Connection from '../cdp/connection';

export interface LaunchParams extends Dap.LaunchParams {
  program: string;
  runtime: string;
}

interface Endpoint {
  pid: string;
  inspectorUrl: string;
}

export class NodeAdapter {
  private _dap: Dap.Api;
  private _adapter: Adapter;
  private _disposables: vscode.Disposable[] = [];
  private _adapterReadyCallback: (adapter: Adapter) => void;
  private _server: net.Server;

  static async create(dap: Dap.Api): Promise<Adapter> {
    return new Promise<Adapter>(f => new NodeAdapter(dap, f));
  }

  constructor(dap: Dap.Api, adapterReadyCallback: (adapter: Adapter) => void) {
    this._dap = dap;
    this._adapterReadyCallback = adapterReadyCallback;
    this._dap.on('initialize', params => this._onInitialize(params));
    this._dap.on('configurationDone', params => this._onConfigurationDone(params));
    this._dap.on('launch', params => this._onLaunch(params as LaunchParams));
    this._dap.on('terminate', params => this._onTerminate(params));
    this._dap.on('disconnect', params => this._onDisconnect(params));
    this._dap.on('restart', params => this._onRestart(params));
  }

  async _onInitialize(params: Dap.InitializeParams): Promise<Dap.InitializeResult | Dap.Error> {
    console.assert(params.linesStartAt1);
    console.assert(params.columnsStartAt1);
    this._dap.initialized({});
    return Adapter.capabilities();
  }

  async _onConfigurationDone(params: Dap.ConfigurationDoneParams): Promise<Dap.ConfigurationDoneResult> {
    return {};
  }

  async _onLaunch(params: LaunchParams): Promise<Dap.LaunchResult | Dap.Error> {
    // params.noDebug

    this._adapter = new Adapter(this._dap, () => { return []; });
    this._adapter.launch('', '');
    this._adapterReadyCallback(this._adapter);
    const pipe = this._startServer();

    const executable = await resolvePath('node');
    if (!executable)
      return errors.createSilentError('Could not locate Node.js executable');

    const p = spawn(executable, [params.program], {
      cwd: vscode.workspace.workspaceFolders![0].uri.fsPath,
      env: { ...process.env, ...env(pipe) },
      stdio: ['inherit', 'pipe', 'pipe']
    });
    p.stderr.on('data', data => {
      console.log('OUT>', data.toString());
    });
    p.stdout.on('data', data => {
      console.log('ERR>', data.toString());
    });
    return {};
  }

  async _onTerminate(params: Dap.TerminateParams): Promise<Dap.TerminateResult | Dap.Error> {
    return {};
  }

  async _onDisconnect(params: Dap.DisconnectParams): Promise<Dap.DisconnectResult | Dap.Error> {
    return {};
  }

  async _onRestart(params: Dap.RestartParams): Promise<Dap.RestartResult | Dap.Error> {
    return {};
  }

  _startServer(): string {
    if (this._server)
      this._server.close();
    const pipePrefix = process.platform === 'win32' ? '\\\\.\\pipe\\' : os.tmpdir();
    const pipe = path.join(pipePrefix, `node-cdp.${process.pid}.sock`);
    this._server = net.createServer(socket => {
      socket.on('data', d => {
        const payload = Buffer.from(d.toString(), 'base64').toString();
        this._startSession(JSON.parse(payload) as Endpoint);
      });
      socket.on('error', e => console.error(e));
    }).listen(pipe);
    return pipe;
  }

  async _startSession(info: Endpoint) {
    const transport = await WebSocketTransport.create(info.inspectorUrl);
    const connection = new Connection(transport);
    const cdp = connection.createSession('');
    const thread = this._adapter.threadManager.createThread(cdp, false);
    if (await thread.initialize())
      connection.onDisconnected(() => thread.dispose());
  }
}

function env(pipe: string) {
  return {
    NODE_OPTIONS: `--require inspector.js`,
    NODE_PATH: `${process.env.NODE_PATH || ''}${path.delimiter}${path.join(__dirname)}`,
    NODE_INSPECTOR_IPC: pipe
  };
}

function resolvePath(command: string): Promise<string|undefined> {
  return new Promise(resolve => which(command, (error: Error | null, path: string | undefined) => resolve(path)));
}
