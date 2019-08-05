// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DebugAdapter, DebugAdapterDelegate } from '../adapter/debugAdapter';
import { SourcePathResolver, InlineScriptOffset, PathLocation } from '../adapter/sources';
import { Target } from '../adapter/targets';
import Cdp from '../cdp/api';
import Connection from '../cdp/connection';
import { PipeTransport } from '../cdp/transport';
import Dap from '../dap/api';
import * as utils from '../utils/urlUtils';
import { Thread } from '../adapter/threads';
import { NodeBreakpointsPredictor } from './nodeBreakpoints';

export interface LaunchParams extends Dap.LaunchParams {
  command: string;
  cwd: string;
  env: Object;
  attachToNode: ['never', 'always', 'top-level'];
}

let counter = 0;

export class NodeDelegate implements DebugAdapterDelegate {
  private _rootPath: string | undefined;
  private _server: net.Server | undefined;
  private _terminal: vscode.Terminal | undefined;
  private _connections: Connection[] = [];
  private _launchParams: LaunchParams | undefined;
  private _pipe: string | undefined;
  private _isRestarting = false;
  _debugAdapter: DebugAdapter;
  _targets = new Map<string, NodeTarget>();
  _pathResolver: NodeSourcePathResolver;
  private _launchBlocker: Promise<any>;
  private _breakpointsPredictor?: NodeBreakpointsPredictor;

  constructor(debugAdapter: DebugAdapter, rootPath: string | undefined) {
    this._debugAdapter = debugAdapter;
    this._rootPath = rootPath;
    this._pathResolver = new NodeSourcePathResolver(this._rootPath);
    this._launchBlocker = Promise.resolve();
    if (rootPath) {
      this._breakpointsPredictor = new NodeBreakpointsPredictor(this._pathResolver, rootPath);
      this._pathResolver.setBreakpointsPredictor(this._breakpointsPredictor);
    }
    debugAdapter.addDelegate(this);
  }

  async onLaunch(params: Dap.LaunchParams): Promise<Dap.LaunchResult | Dap.Error> {
    await this._launchBlocker;
    // params.noDebug
    this._launchParams = params as LaunchParams;
    await this._startServer();
    await this._relaunch();
    return {};
  }

  async _relaunch() {
    this._killRuntime();

    this._terminal = vscode.window.createTerminal({
      name: this._launchParams!.command || 'Debugger terminal',
      cwd: this._launchParams!.cwd || this._rootPath,
      env: this._buildEnv()
    });
    const commandLine = this._launchParams!.command;
    const pid = await this._terminal.processId;
    this._terminal.show();

    onProcessExit(pid, () => {
      if (!this._isRestarting) {
        this._stopServer();
        this._debugAdapter.removeDelegate(this);
      }
    });

    if (commandLine)
      this._terminal.sendText(commandLine, true);
  }

  async onTerminate(params: Dap.TerminateParams): Promise<Dap.TerminateResult | Dap.Error> {
    this._killRuntime();
    await this._stopServer();
    return {};
  }

  async onDisconnect(params: Dap.DisconnectParams): Promise<Dap.DisconnectResult | Dap.Error> {
    this._killRuntime();
    await this._stopServer();
    return {};
  }

  _killRuntime() {
    if (!this._terminal)
      return;
    this._terminal.dispose();
    this._terminal = undefined;
  }

  async onRestart(params: Dap.RestartParams): Promise<Dap.RestartResult | Dap.Error> {
    // Dispose all the connections - Node would not exit child processes otherwise.
    this._isRestarting = true;
    this._killRuntime();
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
    const connection = new Connection(new PipeTransport(socket));
    this._connections.push(connection);
    const cdp = connection.createSession('');
    const { targetInfo } = await new Promise<Cdp.Target.TargetCreatedEvent>(f => cdp.Target.on('targetCreated', f));
    new NodeTarget(this, connection, cdp, targetInfo);
    this._debugAdapter.fireTargetForestChanged();
  }

  targetForest(): Target[] {
    return Array.from(this._targets.values()).filter(t => !t.hasParent());
  }

  adapterDisposed() {
    this._stopServer();
  }

  _buildEnv(): { [key: string]: string | null } {
    const bootloaderJS = path.join(__dirname, 'bootloader.js');
    let result: any = {
      ...process.env,
      ...this._launchParams!.env || {},
      NODE_INSPECTOR_IPC: this._pipe,
      NODE_INSPECTOR_WAIT_FOR_DEBUGGER: this._launchParams!.attachToNode || 'never',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS|| ''} --require ${bootloaderJS}`,
    };
    delete result['ELECTRON_RUN_AS_NODE'];
    return result;
  }

  onSetBreakpoints(params: Dap.SetBreakpointsParams): Promise<void> {
    if (!this._breakpointsPredictor)
      return Promise.resolve();
    const promise = this._breakpointsPredictor.onSetBreakpoints(params);
    this._launchBlocker = Promise.all([this._launchBlocker, promise]);
    return promise;
  }
}

class NodeTarget implements Target {
  private _delegate: NodeDelegate;
  private _connection: Connection;
  private _cdp: Cdp.Api;
  private _parent: NodeTarget | undefined;
  private _children: NodeTarget[] = [];
  private _targetId: string;
  private _targetName: string;
  private _scriptName: string;
  private _serialize = Promise.resolve();
  private _thread: Thread | undefined;
  private _waitingForDebugger: boolean;

  constructor(delegate: NodeDelegate, connection: Connection, cdp: Cdp.Api, targetInfo: Cdp.Target.TargetInfo) {
    this._delegate = delegate;
    this._connection = connection;
    this._cdp = cdp;
    this._targetId = targetInfo.targetId;
    this._scriptName = targetInfo.title;
    this._waitingForDebugger = targetInfo.type === 'waitingForDebugger';
    if (targetInfo.title)
      this._targetName = `${path.basename(targetInfo.title)} [${targetInfo.targetId}]`;
    else
      this._targetName = `[${targetInfo.targetId}]`;

    this._setParent(delegate._targets.get(targetInfo.openerId!));
    delegate._targets.set(targetInfo.targetId, this);
    cdp.Target.on('targetDestroyed', () => this._connection.close());
    connection.onDisconnected(_ => this._disconnected());

    if (targetInfo.type === 'waitingForDebugger')
      this._attach();
  }

 id(): string {
    return this._targetId;
  }

  name(): string {
    return this._targetName;
  }

  fileName(): string | undefined {
    return this._scriptName;
  }

  type(): string {
    return 'node';
  }

  children(): Target[] {
    return Array.from(this._children.values());
  }

  waitingForDebugger(): boolean {
    return this._waitingForDebugger;
  }

  defaultScriptOffset(): InlineScriptOffset {
    return { lineOffset: 0, columnOffset: 62 };
  }

  sourcePathResolver(): SourcePathResolver {
    return this._delegate._pathResolver!;
  }

  supportsCustomBreakpoints(): boolean {
    return false;
  }

  executionContextName(description: Cdp.Runtime.ExecutionContextDescription): string {
    return this._targetName;
  }

  hasParent(): boolean {
    return !!this._parent;
  }

  _setParent(parent?: NodeTarget) {
    if (this._parent)
      this._parent._children.splice(this._parent._children.indexOf(this), 1);
    this._parent = parent;
    if (this._parent)
      this._parent._children.push(this);
  }

  async _disconnected() {
    this._children.forEach(child => child._setParent(this._parent));
    this._setParent(undefined);
    this._delegate._targets.delete(this._targetId);
    await this._detach();
    this._delegate._debugAdapter.fireTargetForestChanged();
  }

  _attach() {
    this._serialize = this._serialize.then(async () => {
      if (this._thread)
        return;
      await this._doAttach();
    });
  }

  _detach() {
    this._serialize = this._serialize.then(async () => {
      if (!this._thread)
        return;
      await this._doDetach();
    });
  }

  async _doAttach() {
    await this._cdp.Target.attachToTarget({ targetId: this._targetId });
    const thread = this._delegate._debugAdapter.threadManager.createThread(this._targetId, this._cdp, this);
    thread.setName(this._targetName);
    thread.initialize();
    thread.onExecutionContextsDestroyed(context => {
      if (context.isDefault())
        this._connection.close();
    });
    this._thread = thread;
    this._cdp.Runtime.runIfWaitingForDebugger({});
  }

  async _doDetach() {
    await this._cdp.Target.detachFromTarget({ targetId: this._targetId });
    const thread = this._thread!;
    this._thread = undefined;
    thread.dispose();
  }

  canRestart(): boolean {
    return false;
  }

  restart() { }

  canStop(): boolean {
    return true;
  }

  stop() {
    process.kill(+this._targetId);
    this._connection.close();
  }

  thread(): Thread | undefined {
    return this._thread;
  }
}

class NodeSourcePathResolver implements SourcePathResolver {
  private _rootPath: string | undefined;
  private _breakpointsPredictor?: NodeBreakpointsPredictor;

  constructor(rootPath: string | undefined) {
    this._rootPath = rootPath;
  }

  rewriteSourceUrl(sourceUrl: string): string {
    // See BrowserSourcePathResolver for explanation of this heuristic.
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

  shouldCheckContentHash(): boolean {
    // Node executes files directly from disk, there is no need to check the content.
    return false;
  }

  predictResolvedLocations(location: PathLocation): PathLocation[] {
    if (!this._breakpointsPredictor)
      return [];
    return this._breakpointsPredictor.predictResolvedLocations(location);
  }

  setBreakpointsPredictor(breakpointsPredictor?: NodeBreakpointsPredictor) {
    this._breakpointsPredictor = breakpointsPredictor;
  }
}

function onProcessExit(pid: number, callback: () => void) {
  const interval = setInterval(() => {
    try {
      process.kill(pid, 0);
    } catch(e) {
      if (e.code !== 'EPERM') {
        clearInterval(interval);
        callback();
      }
    }
  }, 1000);
}
