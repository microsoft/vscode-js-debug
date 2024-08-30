/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { basename } from 'path';
import Cdp from '../../cdp/api';
import Connection from '../../cdp/connection';
import { EventEmitter } from '../../common/events';
import { ILogger, LogTag } from '../../common/logging';
import { absolutePathToFileUrl } from '../../common/urlUtils';
import { AnyNodeConfiguration } from '../../configuration';
import { ITargetOrigin } from '../targetOrigin';
import { IBreakpointPathAndId, ITarget } from '../targets';
import { WatchdogTarget } from './watchdogSpawn';

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

export class NodeTarget implements ITarget {
  private _cdp: Cdp.Api;
  private _targetName: string;
  private _serialize: Promise<Cdp.Api | undefined> = Promise.resolve(undefined);
  private _attached = false;
  private _waitingForDebugger: boolean;
  private _onNameChangedEmitter = new EventEmitter<void>();
  private _onDisconnectEmitter = new EventEmitter<void>();

  public entryBreakpoint: IBreakpointPathAndId | undefined = undefined;

  public readonly onDisconnect = this._onDisconnectEmitter.event;
  public readonly onNameChanged = this._onNameChangedEmitter.event;

  constructor(
    public readonly launchConfig: AnyNodeConfiguration,
    private readonly targetOriginValue: ITargetOrigin,
    public readonly connection: Connection,
    cdp: Cdp.Api,
    public readonly targetInfo: WatchdogTarget,
    public readonly logger: ILogger,
    private readonly lifecycle: INodeTargetLifecycleHooks = {},
    private readonly _parent: ITarget | undefined,
  ) {
    this.connection = connection;
    this._cdp = cdp;
    cdp.pause();
    this._waitingForDebugger = targetInfo.type === 'waitingForDebugger';
    if (targetInfo.title) {
      this._targetName = `${basename(targetInfo.title)} [${targetInfo.processId}]`;
    } else this._targetName = `[${targetInfo.processId}]`;

    cdp.Target.on('targetDestroyed', () => this.connection.close());
    connection.onDisconnected(() => this._disconnected());
  }

  id(): string {
    return this.targetInfo.targetId;
  }

  processId() {
    return this.targetInfo.processId;
  }

  name(): string {
    return this._targetName;
  }

  fileName(): string | undefined {
    return this.targetInfo.title;
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

  public async initialize() {
    if (this.lifecycle.initialized) {
      this.entryBreakpoint = (await this.lifecycle.initialized(this)) || undefined;
    }
  }

  waitingForDebugger(): boolean {
    return this._waitingForDebugger;
  }

  scriptUrlToUrl(url: string): string {
    const isPath = url[0] === '/'
      || (process.platform === 'win32' && url[1] === ':' && url[2] === '\\');
    return isPath ? absolutePathToFileUrl(url) : url;
  }

  supportsCustomBreakpoints(): boolean {
    return false;
  }

  supportsXHRBreakpoints(): boolean {
    return false;
  }

  executionContextName(): string {
    return this._targetName;
  }

  hasParent(): boolean {
    return !!this._parent;
  }

  async runIfWaitingForDebugger() {
    await this._cdp.Runtime.runIfWaitingForDebugger({});
  }

  private async _disconnected() {
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
    const result = await this._cdp.Target.attachToTarget({ targetId: this.targetInfo.targetId });
    if (!result) {
      this.logger.info(LogTag.RuntimeLaunch, 'Failed to attach to target', {
        targetId: this.targetInfo.targetId,
      });
      return; // timed out or cancelled, may have been a short-lived process
    }

    this._cdp.NodeWorker.enable({ waitForDebuggerOnStart: true });

    if (result && '__dynamicAttach' in result) {
      // order matters! The runtime must be enabled first so we know what
      // execution contexts scripts are in
      await this._cdp.Runtime.enable({});
      await this._cdp.Debugger.enable({});
    }

    let defaultCountextId: number;
    this._cdp.Runtime.on('executionContextCreated', event => {
      if (event.context.auxData && event.context.auxData['isDefault']) {
        defaultCountextId = event.context.id;
      }
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

  public async detach(): Promise<void> {
    this._serialize = this._serialize.then(async () => {
      if (this._waitingForDebugger) {
        const cdp = await this._doAttach();
        await cdp?.Runtime.runIfWaitingForDebugger({});
      }

      if (!this._attached) {
        return undefined;
      }

      this._doDetach();
    });
  }

  async _doDetach() {
    await Promise.all([
      this._cdp.Target.detachFromTarget({ targetId: this.targetInfo.targetId }),
      this._cdp.NodeWorker.disable({}),
    ]);

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
