// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Dap from '../dap/api';
import CdpConnection from '../cdp/connection';
import { Adapter } from '../adapter/adapter';

import { spawn, ChildProcess } from 'child_process';
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

let counter = 0;

export class NodeAdapter {
  private _dap: Dap.Api;
  private _adapter: Adapter;
  private _adapterReadyCallback: (adapter: Adapter) => void;
  private _server: net.Server | undefined;
  private _runtime: ChildProcess | undefined;
  private _connections: Connection[] = [];
  private _launchParams: LaunchParams | undefined;
  private _pipe: string | undefined;

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
    this._launchParams = params;

    this._adapter = new Adapter(this._dap);
    this._adapter.launch('', '');
    this._adapterReadyCallback(this._adapter);
    await this._startServer();
    await this._relaunch();
    return {};
  }

  async _relaunch() {
    const executable = await resolvePath(this._launchParams!.runtime);
    if (!executable)
      return errors.createSilentError('Could not locate Node.js executable');

    this._runtime = spawn(executable, [this._launchParams!.program], {
      cwd: vscode.workspace.workspaceFolders![0].uri.fsPath,
      env: { ...process.env, ...env(this._pipe!) },
      stdio: 'ignore'
    });
  }

  async _onTerminate(params: Dap.TerminateParams): Promise<Dap.TerminateResult | Dap.Error> {
    if (this._runtime)
      this._runtime.kill();
    this._stopServer();
    this._adapter.threadManager.disposeAllThreads();
    return {};
  }

  async _onDisconnect(params: Dap.DisconnectParams): Promise<Dap.DisconnectResult | Dap.Error> {
    this._stopServer();
    this._adapter.threadManager.disposeAllThreads();
    return {};
  }

  async _onRestart(params: Dap.RestartParams): Promise<Dap.RestartResult | Dap.Error> {
    for (const c of this._connections)
      c.dispose();
    this._connections = [];
    this._adapter.threadManager.disposeAllThreads();
    this._relaunch();
    return {};
  }

  _startServer() {
    const pipePrefix = process.platform === 'win32' ? '\\\\.\\pipe\\' : os.tmpdir();
    this._pipe = path.join(pipePrefix, `node-cdp.${process.pid}-${++counter}.sock`);
    this._server = net.createServer(socket => {
      socket.on('data', d => {
        const payload = Buffer.from(d.toString(), 'base64').toString();
        this._startSession(JSON.parse(payload) as Endpoint);
      });
      socket.on('error', e => console.error(e));
    }).listen(this._pipe);
  }

  _stopServer() {
    if (this._server)
      this._server.close();
    this._server = undefined;
    for (const c of this._connections)
      c.dispose();
    this._connections = [];
  }

  async _startSession(info: Endpoint) {
    const transport = await WebSocketTransport.create(info.inspectorUrl);
    const connection = new Connection(transport);
    this._connections.push(connection);
    const cdp = connection.createSession('');
    const thread = this._adapter.threadManager.createThread(cdp, false);
    connection.onDisconnected(() => thread.dispose());
    await thread.initialize();
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
