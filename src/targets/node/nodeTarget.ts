/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { basename } from 'path';
import { IThreadDelegate } from '../../adapter/threads';
import Cdp from '../../cdp/api';
import Connection from '../../cdp/connection';
import { EventEmitter } from '../../common/events';
import { ISourcePathResolver } from '../../common/sourcePathResolver';
import { absolutePathToFileUrl } from '../../common/urlUtils';
import { ITargetOrigin } from '../targetOrigin';
import { ITarget, IBreakpointPathAndId } from '../targets';
import { ILogger, LogTag } from '../../common/logging';

export interface INodeTargetLifecycleHooks {
  /**
   * Invoked when the adapter thread is first initialized.
   */
  initialized?(target: NodeTarget): Promise<IBreakpointPathAndId | void>;

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

  public entryBreakpoint: IBreakpointPathAndId | undefined = undefined;

  public readonly onDisconnect = this._onDisconnectEmitter.event;
  public readonly onNameChanged = this._onNameChangedEmitter.event;

  constructor(
    private readonly pathResolver: ISourcePathResolver,
    private readonly targetOriginValue: ITargetOrigin,
    public readonly connection: Connection,
    cdp: Cdp.Api,
    targetInfo: Cdp.Target.TargetInfo,
    public readonly logger: ILogger,
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
    connection.onDisconnected(() => this._disconnected());
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

  targetOrigin(): ITargetOrigin {
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
      this.entryBreakpoint = (await this.lifecycle.initialized(this)) || undefined;
    }
  }

  waitingForDebugger(): boolean {
    return this._waitingForDebugger;
  }

  scriptUrlToUrl(url: string): string {
    const isPath =
      url[0] === '/' || (process.platform === 'win32' && url[1] === ':' && url[2] === '\\');
    return isPath ? absolutePathToFileUrl(url) : url;
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

  executionContextName(): string {
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

  private async _disconnected() {
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

  async _doAttach(): Promise<Cdp.Api | undefined> {
    this._waitingForDebugger = false;
    this._attached = true;
    const result = await this._cdp.Target.attachToTarget({ targetId: this._targetId });
    if (!result) {
      this.logger.info(LogTag.RuntimeLaunch, 'Failed to attach to target', {
        targetId: this._targetId,
      });
      return; // timed out or cancelled, may have been a short-lived process
    }

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
    this.connection.close();
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
