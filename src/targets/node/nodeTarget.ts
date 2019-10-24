/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Target } from '../targets';
import Cdp from '../../cdp/api';
import Connection from '../../cdp/connection';
import { AnyNodeConfiguration } from '../../configuration';
import { InlineScriptOffset, ISourcePathResolver } from '../../common/sourcePathResolver';
import { EventEmitter } from '../../common/events';
import { absolutePathToFileUrl } from '../../common/urlUtils';
import { basename } from 'path';

export class NodeTarget implements Target {
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
  private _onDisconnectEmitter = new EventEmitter<void>();

  public readonly onDisconnect = this._onDisconnectEmitter.event;
  public readonly onNameChanged = this._onNameChangedEmitter.event;

  constructor(
    private readonly pathResolver: ISourcePathResolver,
    private readonly targetOriginValue: string,
    public readonly connection: Connection,
    cdp: Cdp.Api,
    targetInfo: Cdp.Target.TargetInfo,
    args: AnyNodeConfiguration,
  ) {
    this.connection = connection;
    this._cdp = cdp;
    cdp.pause();
    this._targetId = targetInfo.targetId;
    this._scriptName = targetInfo.title;
    this._waitingForDebugger = targetInfo.type === 'waitingForDebugger';
    if (targetInfo.title)
      this._targetName = `${basename(targetInfo.title)} [${targetInfo.targetId}]`;
    else this._targetName = `[${targetInfo.targetId}]`;
    if (args.logging && args.logging.cdp)
      connection.setLogConfig(this._targetName, args.logging.cdp);

    cdp.Target.on('targetDestroyed', () => this.connection.close());
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
    return this.targetOriginValue;
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
    const isPath =
      url[0] === '/' || (process.platform === 'win32' && url[1] === ':' && url[2] === '\\');
    return isPath ? absolutePathToFileUrl(url) || url : url;
  }

  sourcePathResolver(): ISourcePathResolver {
    return this.pathResolver;
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

  public setParent(parent?: NodeTarget) {
    if (this._parent) this._parent._children.splice(this._parent._children.indexOf(this), 1);
    this._parent = parent;
    if (this._parent) this._parent._children.push(this);
  }

  async _disconnected() {
    this._children.forEach(child => child.setParent(this._parent));
    this.setParent(undefined);
    this._onDisconnectEmitter.fire();
  }

  canAttach(): boolean {
    return !this._attached;
  }

  async attach(): Promise<Cdp.Api | undefined> {
    this._serialize = this._serialize.then(async () => {
      if (this._attached) return;
      return this._doAttach();
    });
    return this._serialize;
  }

  async _doAttach(): Promise<Cdp.Api> {
    this._waitingForDebugger = false;
    this._attached = true;
    const result = await this._cdp.Target.attachToTarget({ targetId: this._targetId });
    if (result && '__dynamicAttach' in result) {
      await this._cdp.Debugger.enable({});
      await this._cdp.Runtime.enable({});
    }

    let defaultCountextId: number;
    this._cdp.Runtime.on('executionContextCreated', event => {
      if (event.context.auxData && event.context.auxData['isDefault'])
        defaultCountextId = event.context.id;
    });
    this._cdp.Runtime.on('executionContextDestroyed', event => {
      if (event.executionContextId === defaultCountextId) this.connection.close();
    });
    return this._cdp;
  }

  public async afterBind() {
    this._cdp.resume();
  }

  canDetach(): boolean {
    return this._attached;
  }

  async detach(): Promise<void> {
    this._serialize = this._serialize.then(async () => {
      if (!this._attached) return undefined;
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

  restart() {}

  canStop(): boolean {
    return true;
  }

  stop() {
    const processId = Number(this._targetId);
    if (processId > 0) {
      try {
        process.kill(+this._targetId);
      } catch (e) {
        // ignored
      }
    }

    this.connection.close();
  }
}

const kNodeScripts = [
  '_http_agent.js',
  '_http_client.js',
  '_http_common.js',
  '_http_incoming.js',
  '_http_outgoing.js',
  '_http_server.js',
  '_stream_duplex.js',
  '_stream_passthrough.js',
  '_stream_readable.js',
  '_stream_transform.js',
  '_stream_wrap.js',
  '_stream_writable.js',
  '_tls_common.js',
  '_tls_wrap.js',
  'assert.js',
  'async_hooks.js',
  'buffer.js',
  'child_process.js',
  'cluster.js',
  'console.js',
  'constants.js',
  'crypto.js',
  'dgram.js',
  'dns.js',
  'domain.js',
  'events.js',
  'fs.js',
  'http.js',
  'http2.js',
  'https.js',
  'inspector.js',
  'module.js',
  'net.js',
  'os.js',
  'path.js',
  'perf_hooks.js',
  'process.js',
  'punycode.js',
  'querystring.js',
  'readline.js',
  'repl.js',
  'stream.js',
  'string_decoder.js',
  'sys.js',
  'timers.js',
  'tls.js',
  'trace_events.js',
  'tty.js',
  'url.js',
  'util.js',
  'v8.js',
  'vm.js',
  'worker_threads.js',
  'zlib.js',
];

const kNodeBlackboxPattern =
  '^internal/.+.js|' + kNodeScripts.map(script => script.replace('.', '.')).join('|') + '$';
