// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter, Event, Disposable } from '../../common/events';
import Cdp from '../../cdp/api';
import Connection from '../../cdp/connection';
import { PipeTransport } from '../../cdp/transport';
import { InlineScriptOffset, SourcePathResolver } from '../../common/sourcePathResolver';
import { Launcher, Target, LaunchResult } from '../../targets/targets';
import * as urlUtils from '../../common/urlUtils';
import { execFileSync } from 'child_process';
import { CommonLaunchParams } from '../../common/commonLaunchParams';

export interface LaunchParams extends CommonLaunchParams {
  command: string;
  cwd?: string;
  env?: Object;
  nodeFilter?: string;
  args?: string[];
}

export interface ProgramLauncher extends Disposable {
  launchProgram(name: string, cwd: string | undefined, env: { [key: string]: string | null }, command: string): void;
  stopProgram(): void;
  onProgramStopped: Event<void>;
}

let counter = 0;

export class NodeLauncher implements Launcher {
  private _server: net.Server | undefined;
  private _programLauncher: ProgramLauncher;
  private _connections: Connection[] = [];
  _launchParams: LaunchParams | undefined;
  private _pipe: string | undefined;
  private _isRestarting = false;
  _targets = new Map<string, NodeTarget>();
  _pathResolver?: NodeSourcePathResolver;
  _targetOrigin: any;
  private _onTerminatedEmitter = new EventEmitter<void>();
  readonly onTerminated = this._onTerminatedEmitter.event;
  _onTargetListChangedEmitter = new EventEmitter<void>();
  readonly onTargetListChanged = this._onTargetListChangedEmitter.event;

  constructor(programLauncher: ProgramLauncher) {
    this._programLauncher = programLauncher;
    this._programLauncher.onProgramStopped(() => {
      if (!this._isRestarting) {
        this._stopServer();
        this._onTerminatedEmitter.fire();
      }
    });
  }

  async launch(params: CommonLaunchParams, targetOrigin: any): Promise<LaunchResult> {
    if (!('command' in params))
      return { blockSessionTermination: false };
    this._launchParams = params as LaunchParams;
    this._pathResolver = new NodeSourcePathResolver(this._launchParams.rootPath);
    this._targetOrigin = targetOrigin;
    await this._startServer();
    this._launchProgram();
    return { blockSessionTermination: true };
  }

  _launchProgram() {
    this._programLauncher.stopProgram();
    const launchParams = this._launchParams!;
    const args = (launchParams.args || []).map(arg => `"${arg}"`);
    const commandLine = [this._normalizeCommandLine(launchParams.command), ...args].join(' ');
    this._programLauncher.launchProgram(launchParams.command, launchParams.cwd || launchParams.rootPath, this._buildEnv(), commandLine);
  }

  /** Normalize the command line */
  private _normalizeCommandLine(unnormalizedCommand: string): string {
    const tokens = unnormalizedCommand.split(' ');
    tokens[0] = path.normalize(tokens[0]);
    return tokens.join(' ');
  }

  async terminate(): Promise<void> {
    this._programLauncher.stopProgram();
    await this._stopServer();
  }

  async disconnect(): Promise<void> {
    this._programLauncher.stopProgram();
    await this._stopServer();
  }

  async restart(): Promise<void> {
    // Dispose all the connections - Node would not exit child processes otherwise.
    this._isRestarting = true;
    this._programLauncher.stopProgram();
    this._stopServer();
    await this._startServer();
    this._launchProgram();
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
    const cdp = connection.rootSession();
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
      NODE_INSPECTOR_PPID: '',
      NODE_INSPECTOR_WAIT_FOR_DEBUGGER: this._launchParams!.nodeFilter || '',
      // Require our bootloader first, to run it before any other bootloader
      // we could have injected in the parent process.
      NODE_OPTIONS: `--require ${bootloaderJS} ${process.env.NODE_OPTIONS|| ''}`,
      // Supply some node executable for running top-level watchdog in Electron
      // environments. Bootloader will replace this with actual node executable used if any.
      NODE_INSPECTOR_EXEC_PATH: findNode() || ''
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
  private _onNameChangedEmitter = new EventEmitter<void>();
  readonly onNameChanged = this._onNameChangedEmitter.event;

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
    if (this._launcher._launchParams && this._launcher._launchParams.logging)
      connection.setLogConfig(this._targetName, this._launcher._launchParams.logging.cdp);

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

  blackboxPattern(): string | undefined {
    return kNodeBlackboxPattern;
  }

  scriptUrlToUrl(url: string): string {
    const isPath = url[0] === '/' || (process.platform === 'win32' && url[1] === ':' && url[2] === '\\');
    return isPath ? (urlUtils.absolutePathToFileUrl(url) || url) : url;
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
    try {
      process.kill(+this._targetId);
    } catch (e) {
    }
    this._connection.close();
  }
}

export class NodeSourcePathResolver implements SourcePathResolver {
  private _basePath: string | undefined;

  constructor(basePath: string | undefined) {
    this._basePath = basePath;
  }

  urlToAbsolutePath(url: string): string {
    const absolutePath = urlUtils.fileUrlToAbsolutePath(url);
    if (absolutePath)
      return absolutePath;

    if (!this._basePath)
      return '';

    const webpackPath = urlUtils.webpackUrlToPath(url, this._basePath);
    return webpackPath || '';
  }

  absolutePathToUrl(absolutePath: string): string | undefined {
    return urlUtils.absolutePathToFileUrl(path.normalize(absolutePath));
  }
}

function findNode(): string | undefined {
  // TODO: implement this for Windows.
  if (process.platform !== 'linux' && process.platform !== 'darwin')
    return;
  try {
    return execFileSync('which', ['node'], { stdio: 'pipe' }).toString().split(/\r?\n/)[0];
  } catch (e) {
  }
}

const kNodeScripts = ['_http_agent.js', '_http_client.js', '_http_common.js', '_http_incoming.js',
    '_http_outgoing.js', '_http_server.js', '_stream_duplex.js', '_stream_passthrough.js', '_stream_readable.js',
    '_stream_transform.js', '_stream_wrap.js', '_stream_writable.js', '_tls_common.js', '_tls_wrap.js',
    'assert.js', 'async_hooks.js', 'buffer.js', 'child_process.js', 'cluster.js', 'console.js', 'constants.js',
    'crypto.js', 'dgram.js', 'dns.js', 'domain.js', 'events.js', 'fs.js', 'http.js', 'http2.js', 'https.js',
    'inspector.js', 'module.js', 'net.js', 'os.js', 'path.js', 'perf_hooks.js', 'process.js', 'punycode.js',
    'querystring.js', 'readline.js', 'repl.js', 'stream.js', 'string_decoder.js', 'sys.js', 'timers.js', 'tls.js',
    'trace_events.js', 'tty.js', 'url.js', 'util.js', 'v8.js', 'vm.js', 'worker_threads.js', 'zlib.js'];
const kNodeBlackboxPattern =
    '^internal/.+\.js|' + kNodeScripts.map(script => script.replace('.', '\.')).join('|') + '$';
