/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as which from 'which';
import { Adapter } from '../adapter/adapter';
import { Configurator } from '../adapter/configurator';
import * as errors from '../adapter/errors';
import { PipeTransport } from '../cdp/transport';
import { ExecutionContextTree, Thread, ThreadManagerDelegate } from '../adapter/threads';
import Connection from '../cdp/connection';
import Dap from '../dap/api';
import Cdp from '../cdp/api';

export interface LaunchParams extends Dap.LaunchParams {
  program: string;
  runtime: string;
}

let counter = 0;

export class NodeAdapter implements ThreadManagerDelegate {
  private _dap: Dap.Api;
  private _configurator: Configurator;
  private _rootPath: string | undefined;
  private _adapter: Adapter;
  private _adapterReadyCallback: (adapter: Adapter) => void;
  private _server: net.Server | undefined;
  private _runtime: ChildProcess | undefined;
  private _connections: Connection[] = [];
  private _launchParams: LaunchParams | undefined;
  private _pipe: string | undefined;
  private _targets = new Map<string, Thread>();
  private _isRestarting: boolean;

  static async create(dap: Dap.Api, rootPath: string | undefined): Promise<Adapter> {
    return new Promise<Adapter>(f => new NodeAdapter(dap, rootPath, f));
  }

  constructor(dap: Dap.Api, rootPath: string | undefined, adapterReadyCallback: (adapter: Adapter) => void) {
    this._dap = dap;
    this._rootPath = rootPath;
    this._adapterReadyCallback = adapterReadyCallback;
    this._configurator = new Configurator(dap);
    this._dap.on('initialize', params => this._onInitialize(params));
    this._dap.on('launch', params => this._onLaunch(params as LaunchParams));
    this._dap.on('terminate', params => this._onTerminate(params));
    this._dap.on('disconnect', params => this._onDisconnect(params));
    this._dap.on('restart', params => this._onRestart(params));
  }

  async _onInitialize(params: Dap.InitializeParams): Promise<Dap.InitializeResult | Dap.Error> {
    console.assert(params.linesStartAt1);
    console.assert(params.columnsStartAt1);
    this._dap.initialized({});
    return this._configurator.capabilities();
  }

  async _onLaunch(params: LaunchParams): Promise<Dap.LaunchResult | Dap.Error> {
    // params.noDebug
    this._launchParams = params;

    this._adapter = new Adapter(this._dap, this._rootPath, '', '');
    this._adapter.threadManager.setDelegate(this);
    await this._adapter.configure(this._configurator);

    this._adapterReadyCallback(this._adapter);
    await this._startServer();
    const error = await this._relaunch();
    return error || {};
  }

  async _relaunch(): Promise<Dap.LaunchResult | undefined> {
    await this._killRuntime();

    const executable = await resolvePath(this._launchParams!.runtime);
    if (!executable)
      return errors.createSilentError('Could not locate Node.js executable');

    this._runtime = spawn(executable, [this._launchParams!.program], {
      cwd: vscode.workspace.workspaceFolders![0].uri.fsPath,
      env: { ...process.env, ...env(this._pipe!) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output: vscode.OutputChannel | undefined = vscode.window.createOutputChannel(this._launchParams!.program);
    this._runtime.stdout.on('data', data => {
      if (output)
        output.append(data.toString())
    });
    this._runtime.stderr.on('data', data => output && output.append(data.toString()));
    this._runtime.on('exit', () => {
      output!.dispose();
      output = undefined;
      this._runtime = undefined;
    });
  }

  async _onTerminate(params: Dap.TerminateParams): Promise<Dap.TerminateResult | Dap.Error> {
    await this._killRuntime();
    await this._stopServer();
    return {};
  }

  async _onDisconnect(params: Dap.DisconnectParams): Promise<Dap.DisconnectResult | Dap.Error> {
    await this._killRuntime();
    await this._stopServer();
    return {};
  }

  async _killRuntime() {
    if (!this._runtime || this._runtime.killed)
      return;
    this._runtime.kill();
    let callback = () => {};
    const result = new Promise(f => callback = f);
    this._runtime.on('exit', callback);
    return result;
  }

  async _onRestart(params: Dap.RestartParams): Promise<Dap.RestartResult | Dap.Error> {
    // Dispose all the connections - Node would not exit child processes otherwise.
    this._isRestarting = true;
    await this._killRuntime();
    this._stopServer();
    await this._startServer();
    await this._relaunch();
    this._isRestarting = false;
    return {};
  }

  _startServer() {
    const pipePrefix = process.platform === 'win32' ? '\\\\.\\pipe\\' : os.tmpdir();
    this._pipe = path.join(pipePrefix, `node-cdp.${process.pid}-${++counter}.sock`);
    this._server = net.createServer(socket => {
      this._startSession(socket);
    }).listen(this._pipe);
  }

  _stopServer() {
    if (this._server)
      this._server.close();
    this._server = undefined;
    this._connections.forEach(c => c.close());
    this._connections = [];
  }

  async _startSession(socket: net.Socket) {
    const transport = new PipeTransport(socket);
    const connection = new Connection(transport);
    this._connections.push(connection);
    const cdp = connection.createSession('');
    const { targetInfo } = await new Promise(f => cdp.Target.on('targetCreated', f)) as Cdp.Target.TargetCreatedEvent;
    const parentThread = this._targets.get(targetInfo.openerId!);
    const thread = this._adapter.threadManager.createThread(cdp, parentThread, {});
    this._targets.set(targetInfo.targetId, thread);
    let threadName: string;
    if (targetInfo.title)
      threadName = `${path.basename(targetInfo.title)} [${targetInfo.targetId}]`;
    else
      threadName = `[${targetInfo.targetId}]`;
    thread.setName(threadName);
    connection.onDisconnected(() => {
      this._targets.delete(targetInfo.targetId);
      thread.dispose();
      if (!this._targets.size && !this._isRestarting)
        this._dap.terminated({});
    });
    thread.initialize();
    cdp.Runtime.on('executionContextDestroyed', () => {
      connection.close();
    });
    cdp.Runtime.runIfWaitingForDebugger({});
  }

  executionContextForest(): ExecutionContextTree[] | undefined {
    const result: ExecutionContextTree[] = [];
    const visit = (thread: Thread, container: ExecutionContextTree[]) => {
      const context = thread.defaultExecutionContext();
      if (context) {
        const contextTree = {
          name: thread.name(),
          threadId: thread.threadId(),
          contextId: context.id,
          children: [],
        };
        container.push(contextTree);
        for (const child of thread.childThreads())
          visit(child, contextTree.children);
      } else {
        for (const child of thread.childThreads())
          visit(child, container);
      }
    };
    this._adapter.threadManager.topLevelThreads().forEach(t => visit(t, result));
    return result;
  }
}

function env(pipe: string) {
  return {
    NODE_OPTIONS: `--require bootloader.js`,
    NODE_PATH: `${process.env.NODE_PATH || ''}${path.delimiter}${path.join(__dirname)}`,
    NODE_INSPECTOR_IPC: pipe
  };
}

function resolvePath(command: string): Promise<string | undefined> {
  return new Promise(resolve => which(command, (error: Error | null, path: string | undefined) => resolve(path)));
}
