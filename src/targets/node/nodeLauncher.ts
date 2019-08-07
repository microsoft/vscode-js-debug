// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import Cdp from '../../cdp/api';
import Connection from '../../cdp/connection';
import { PipeTransport } from '../../cdp/transport';
import { InlineScriptOffset, SourcePathResolver } from '../../common/sourcePathResolver';
import Dap from '../../dap/api';
import { Launcher, Target } from '../../targets/targets';
import * as utils from '../../utils/urlUtils';

export interface LaunchParams extends Dap.LaunchParams {
  command: string;
  cwd?: string;
  env?: Object;
  nodeFilter?: string;
}

let counter = 0;

export class NodeLauncher implements Launcher {
  private _rootPath: string | undefined;
  private _server: net.Server | undefined;
  private _terminal: vscode.Terminal | undefined;
  private _connections: Connection[] = [];
  private _launchParams: LaunchParams | undefined;
  private _pipe: string | undefined;
  private _isRestarting = false;
  _targets = new Map<string, NodeTarget>();
  _pathResolver: NodeSourcePathResolver;
  _targetOrigin: any;
  private _onTerminatedEmitter = new vscode.EventEmitter<void>();
  readonly onTerminated = this._onTerminatedEmitter.event;
  _onTargetListChangedEmitter = new vscode.EventEmitter<void>();
  readonly onTargetListChanged = this._onTargetListChangedEmitter.event;

  constructor(rootPath: string | undefined) {
    this._rootPath = rootPath;
    this._pathResolver = new NodeSourcePathResolver();
  }

  async launch(params: any, targetOrigin: any): Promise<void> {
    if (!('command' in params))
      return;
    // params.noDebug
    this._launchParams = params as LaunchParams;
    this._targetOrigin = targetOrigin;
    await this._startServer();
    await this._relaunch();
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
        this._onTerminatedEmitter.fire();
      }
    });

    if (commandLine)
      this._terminal.sendText(commandLine, true);
  }

  async terminate(): Promise<void> {
    this._killRuntime();
    await this._stopServer();
  }

  async disconnect(): Promise<void> {
    this._killRuntime();
    await this._stopServer();
  }

  _killRuntime() {
    if (!this._terminal)
      return;
    this._terminal.dispose();
    this._terminal = undefined;
  }

  async restart(): Promise<void> {
    // Dispose all the connections - Node would not exit child processes otherwise.
    this._isRestarting = true;
    this._killRuntime();
    this._stopServer();
    await this._startServer();
    await this._relaunch();
    this._isRestarting = false;
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
    this._onTargetListChangedEmitter.fire();
  }

  targetList(): Target[] {
    return Array.from(this._targets.values());
  }

  dispose() {
    this._stopServer();
  }

  _buildEnv(): { [key: string]: string | null } {
    const bootloaderJS = path.join(__dirname, 'bootloader.js');
    let result: any = {
      ...process.env,
      ...this._launchParams!.env || {},
      NODE_INSPECTOR_IPC: this._pipe,
      NODE_INSPECTOR_WAIT_FOR_DEBUGGER: this._launchParams!.nodeFilter || '',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS|| ''} --require ${bootloaderJS}`,
    };
    delete result['ELECTRON_RUN_AS_NODE'];
    return result;
  }
}

class NodeTarget implements Target {
  private _launcher: NodeLauncher;
  private _connection: Connection;
  private _cdp: Cdp.Api;
  private _parent: NodeTarget | undefined;
  private _children: NodeTarget[] = [];
  private _targetId: string;
  private _targetName: string;
  private _scriptName: string;
  private _serialize: Promise<Cdp.Api | undefined> = Promise.resolve(undefined);
  private _attached = false;
  private _waitingForDebugger: boolean;

  constructor(launcher: NodeLauncher, connection: Connection, cdp: Cdp.Api, targetInfo: Cdp.Target.TargetInfo) {
    this._launcher = launcher;
    this._connection = connection;
    this._cdp = cdp;
    this._targetId = targetInfo.targetId;
    this._scriptName = targetInfo.title;
    this._waitingForDebugger = targetInfo.type === 'waitingForDebugger';
    if (targetInfo.title)
      this._targetName = `${path.basename(targetInfo.title)} [${targetInfo.targetId}]`;
    else
      this._targetName = `[${targetInfo.targetId}]`;

    this._setParent(launcher._targets.get(targetInfo.openerId!));
    launcher._targets.set(targetInfo.targetId, this);
    cdp.Target.on('targetDestroyed', () => this._connection.close());
    connection.onDisconnected(_ => this._disconnected());
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

  targetOrigin(): any {
    return this._launcher._targetOrigin;
  }

  parent(): Target | undefined {
    return this._parent;
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

  scriptUrlToUrl(url: string): string {
    const isPath = url[0] === '/' || (process.platform === 'win32' && url[1] === ':' && url[2] === '\\');
    return isPath ? (utils.absolutePathToFileUrl(url) || url) : url;
  }

  sourcePathResolver(): SourcePathResolver {
    return this._launcher._pathResolver!;
  }

  supportsCustomBreakpoints(): boolean {
    return false;
  }

  shouldCheckContentHash(): boolean {
    // Node executes files directly from disk, there is no need to check the content.
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
    this._launcher._targets.delete(this._targetId);
    // await this.detach();
    this._launcher._onTargetListChangedEmitter.fire();
  }

  canAttach(): boolean {
    return !this._attached;
  }

  async attach(): Promise<Cdp.Api | undefined> {
    this._serialize = this._serialize.then(async () => {
      if (this._attached)
        return;
      return this._doAttach();
    });
    return this._serialize;
  }

  async _doAttach(): Promise<Cdp.Api> {
    this._waitingForDebugger = false;
    this._attached = true;
    await this._cdp.Target.attachToTarget({ targetId: this._targetId });
    let defaultCountextId: number;
    this._cdp.Runtime.on('executionContextCreated', event => {
      if (event.context.auxData && event.context.auxData['isDefault'])
        defaultCountextId = event.context.id;
    });
    this._cdp.Runtime.on('executionContextDestroyed', event => {
      if (event.executionContextId === defaultCountextId)
        this._connection.close();
    });
    return this._cdp;
  }

  canDetach(): boolean {
    return this._attached;
  }

  async detach(): Promise<void> {
    this._serialize = this._serialize.then(async () => {
      if (!this._attached)
        return undefined;
      this._doDetach();
    });
  }

  async _doDetach() {
    await this._cdp.Target.detachFromTarget({ targetId: this._targetId });
    this._attached = false;
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
}

class NodeSourcePathResolver implements SourcePathResolver {

  urlToAbsolutePath(url: string): string {
    return utils.fileUrlToAbsolutePath(url) || '';
  }

  absolutePathToUrl(absolutePath: string): string | undefined {
    return utils.absolutePathToFileUrl(path.normalize(absolutePath));
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
