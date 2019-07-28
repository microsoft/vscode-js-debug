/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as which from 'which';
import { DebugAdapter } from '../adapter/debugAdapter';
import * as errors from '../adapter/errors';
import { SourcePathResolver } from '../adapter/sources';
import { ExecutionContext } from '../adapter/threads';
import Cdp from '../cdp/api';
import Connection from '../cdp/connection';
import { PipeTransport } from '../cdp/transport';
import Dap from '../dap/api';
import * as utils from '../utils/urlUtils';

export interface LaunchParams extends Dap.LaunchParams {
  args: string[];
  runtimeExecutable: string;
  cwd: string;
}

let counter = 0;

interface Target extends ExecutionContext {
  parent?: ExecutionContext;
}

export class NodeAdapter {
  private _dap: Dap.Api;
  private _debugAdapter: DebugAdapter;
  private _rootPath: string | undefined;
  private _adapterReadyCallback: (adapter: DebugAdapter) => void;
  private _server: net.Server | undefined;
  private _runtime: ChildProcess | undefined;
  private _connections: Connection[] = [];
  private _launchParams: LaunchParams | undefined;
  private _pipe: string | undefined;
  private _targets = new Map<string, Target>();
  private _isRestarting: boolean;
  private _pathResolver: NodeSourcePathResolver;

  static async create(dap: Dap.Api, rootPath: string | undefined): Promise<DebugAdapter> {
    return new Promise<DebugAdapter>(f => new NodeAdapter(dap, rootPath, f));
  }

  constructor(dap: Dap.Api, rootPath: string | undefined, adapterReadyCallback: (adapter: DebugAdapter) => void) {
    this._dap = dap;
    this._rootPath = rootPath;
    this._adapterReadyCallback = adapterReadyCallback;
    this._debugAdapter = new DebugAdapter(dap);
    this._dap.on('launch', params => this._onLaunch(params as LaunchParams));
    this._dap.on('terminate', params => this._onTerminate(params));
    this._dap.on('disconnect', params => this._onDisconnect(params));
    this._dap.on('restart', params => this._onRestart(params));
  }

  async _onLaunch(params: LaunchParams): Promise<Dap.LaunchResult | Dap.Error> {
    // params.noDebug
    this._launchParams = params;
    this._pathResolver = new NodeSourcePathResolver(this._rootPath);

    await this._debugAdapter.launch({
      executionContextForest: () => this.executionContextForest(),
      adapterDisposed: () => this._stopServer()
    });

    this._adapterReadyCallback(this._debugAdapter);
    await this._startServer();
    const error = await this._relaunch();
    return error || {};
  }

  async _relaunch(): Promise<Dap.LaunchResult | undefined> {
    await this._killRuntime();

    const executable = await resolvePath(this._launchParams!.runtimeExecutable);
    if (!executable)
      return errors.createSilentError('Could not locate Node.js executable');

    this._runtime = spawn(executable, this._launchParams!.args || [], {
      cwd: this._launchParams!.cwd,
      env: env(this._pipe!),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const outputName = [executable, ...(this._launchParams!.args || [])].join(' ');
    let output: vscode.OutputChannel | undefined = vscode.window.createOutputChannel(outputName);
    output.show();
    this._runtime.stdout.on('data', data => output && output.append(data.toString()));
    this._runtime.stderr.on('data', data => output && output.append(data.toString()));
    this._runtime.on('exit', () => {
      output = undefined;
      this._runtime = undefined;
      if (!this._isRestarting)
        this._dap.terminated({});
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

    const setParent = (child: Target, parent?: Target) => {
      if (child.parent)
        child.parent.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = parent;
      if (child.parent)
        child.parent.children.push(child);
    };

    const thread = this._debugAdapter.threadManager.createThread(targetInfo.targetId, cdp, {
      copyToClipboard: (text: string) => vscode.env.clipboard.writeText(text),
      defaultScriptOffset: {lineOffset: 0, columnOffset: 62},
      sourcePathResolver: this._pathResolver,
      canStopThread: () => true,
      stopThread: () => this._terminateProcess(thread.threadId())
    });
    let threadName: string;
    if (targetInfo.title)
      threadName = `${path.basename(targetInfo.title)} [${targetInfo.targetId}]`;
    else
      threadName = `[${targetInfo.targetId}]`;
    thread.setName(threadName);

    const target: Target = {
      name: thread.name(),
      thread: thread,
      isThread: true,
      children: [],
      type: 'node'
    };
    this._targets.set(targetInfo.targetId, target);
    setParent(target, this._targets.get(targetInfo.openerId!));

    connection.onDisconnected(() => {
      target.children.forEach(child => setParent(child, target.parent));
      setParent(target, undefined);
      this._targets.delete(targetInfo.targetId);
      thread.dispose();
    });
    thread.initialize();
    cdp.Runtime.on('executionContextDestroyed', () => {
      connection.close();
    });
    cdp.Runtime.runIfWaitingForDebugger({});
  }

  _terminateProcess(pid: string) {
    process.kill(+pid);
  }

  executionContextForest(): ExecutionContext[] {
    return Array.from(this._targets.values()).filter(t => !t.parent);
  }
}

function env(pipe: string) {
  const result = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS|| ''} --require bootloader.js`,
    NODE_PATH: `${process.env.NODE_PATH || ''}${path.delimiter}${path.join(__dirname)}`,
    NODE_INSPECTOR_IPC: pipe
  };
  delete result['ELECTRON_RUN_AS_NODE'];
  return result;
}

function resolvePath(command: string): Promise<string | undefined> {
  return new Promise(resolve => which(command, (error: Error | null, path: string | undefined) => resolve(path)));
}

class NodeSourcePathResolver implements SourcePathResolver {
  private _rootPath: string | undefined;

  constructor(rootPath: string | undefined) {
    this._rootPath = rootPath;
  }

  rewriteSourceUrl(sourceUrl: string): string {
    // See ChromeSourcePathResolver for explanation of this heuristic.
    if (this._rootPath && sourceUrl.startsWith(this._rootPath) && !utils.isValidUrl(sourceUrl))
      return utils.absolutePathToFileUrl(sourceUrl) || sourceUrl;
    return sourceUrl;
  }

  urlToAbsolutePath(url: string): string {
    return utils.fileUrlToAbsolutePath(url) || '';
  }

  absolutePathToUrl(absolutePath: string): string | undefined {
    return utils.absolutePathToFileUrl(path.normalize(absolutePath));
  }

  scriptUrlToUrl(url: string): string {
    const isPath = url[0] === '/' || (process.platform === 'win32' && url[1] === ':' && url[2] === '\\');
    return isPath ? (utils.absolutePathToFileUrl(url) || url) : url;
  }
}
