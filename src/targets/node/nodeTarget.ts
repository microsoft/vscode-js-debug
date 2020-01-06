/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ITarget } from '../targets';
import Cdp from '../../cdp/api';
import Connection from '../../cdp/connection';
import { InlineScriptOffset, ISourcePathResolver } from '../../common/sourcePathResolver';
import { EventEmitter } from '../../common/events';
import { absolutePathToFileUrl } from '../../common/urlUtils';
import { basename } from 'path';
import { ScriptSkipper } from '../../adapter/scriptSkipper';
import { IThreadDelegate } from '../../adapter/threads';

export interface INodeTargetLifecycleHooks {
  /**
   * Invoked when the adapter thread is first initialized.
   */
  initialized?(target: NodeTarget): Promise<void>;

  /**
   * Invoked when the target is stopped.
   */
  close?(target: NodeTarget): void;
}

export class NodeTarget implements ITarget, IThreadDelegate {
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

  private _scriptSkipper?: ScriptSkipper;

  public readonly onDisconnect = this._onDisconnectEmitter.event;
  public readonly onNameChanged = this._onNameChangedEmitter.event;

  constructor(
    private readonly pathResolver: ISourcePathResolver,
    private readonly targetOriginValue: string,
    public readonly connection: Connection,
    cdp: Cdp.Api,
    targetInfo: Cdp.Target.TargetInfo,
    private readonly lifecycle: INodeTargetLifecycleHooks = {},
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

  parent(): ITarget | undefined {
    return this._parent;
  }

  children(): ITarget[] {
    return Array.from(this._children.values());
  }

  public async initialize() {
    if (this.lifecycle.initialized) {
      this.lifecycle.initialized(this);
    }
  }

  waitingForDebugger(): boolean {
    return this._waitingForDebugger;
  }

  defaultScriptOffset(): InlineScriptOffset {
    return { lineOffset: 0, columnOffset: 0 };
  }

  skipFiles(): ScriptSkipper | undefined {
    return this._scriptSkipper;
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
    // todo(connor4312): all targets need content hashing, remove dead code
    return true;
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

  restart() {
    // no-op
  }

  canStop(): boolean {
    return true;
  }

  stop() {
    try {
      if (this.lifecycle.close) {
        this.lifecycle.close(this);
      }
    } finally {
      this.connection.close();
    }
  }
}
