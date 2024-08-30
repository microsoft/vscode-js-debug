/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { URL } from 'url';
import Cdp from '../../cdp/api';
import { EventEmitter } from '../../common/events';
import { ILogger } from '../../common/logging';
import * as urlUtils from '../../common/urlUtils';
import { AnyChromiumConfiguration } from '../../configuration';
import { ITarget } from '../../targets/targets';
import { signalReadyExpr } from '../node/extensionHostExtras';
import { BrowserTargetManager } from './browserTargetManager';

export const enum BrowserTargetType {
  Page = 'page',
  ServiceWorker = 'service_worker',
  Worker = 'worker',
  IFrame = 'iframe',
  Other = 'other',
}

/**
 * Types that can run JavaScript.
 */
export const jsTypes: ReadonlySet<BrowserTargetType> = new Set([
  BrowserTargetType.Page,
  BrowserTargetType.IFrame,
  BrowserTargetType.Worker,
  BrowserTargetType.ServiceWorker,
]);

/**
 * Types for which we should attach DOM debug handlers.
 */
export const domDebuggerTypes: ReadonlySet<BrowserTargetType> = new Set([
  BrowserTargetType.Page,
  BrowserTargetType.IFrame,
]);

/**
 * Types that can be restarted.
 */
const restartableTypes: ReadonlySet<BrowserTargetType> = new Set([
  BrowserTargetType.Page,
  BrowserTargetType.IFrame,
]);

/**
 * Types that can be stopped.
 */
const stoppableTypes = restartableTypes;

export type PauseOnExceptionsState = 'none' | 'uncaught' | 'all';

export class BrowserTarget implements ITarget {
  readonly parentTarget: BrowserTarget | undefined;
  private _cdp: Cdp.Api;
  private _ondispose: (t: BrowserTarget) => void;
  private _waitingForDebugger: boolean;
  private _attached = false;
  private _customNameComputeFn?: (t: BrowserTarget) => string | undefined;
  _onNameChangedEmitter = new EventEmitter<void>();

  public readonly onNameChanged = this._onNameChangedEmitter.event;
  public readonly entryBreakpoint = undefined;

  public get targetInfo(): Readonly<Cdp.Target.TargetInfo> {
    return this._targetInfo;
  }

  public get targetId() {
    return this._targetInfo.targetId;
  }

  /**
   * @inheritdoc
   */
  public get independentLifeycle() {
    return restartableTypes.has(this.type());
  }

  /**
   * @inheritdoc
   */
  public get supplementalConfig() {
    const type = this.type();
    return {
      __browserTargetType: type,
      __usePerformanceFromParent: type !== BrowserTargetType.Page,
    };
  }

  _children: Map<Cdp.Target.TargetID, BrowserTarget> = new Map();

  public readonly sourcePathResolver = this._manager._sourcePathResolver;

  constructor(
    private readonly _manager: BrowserTargetManager,
    private _targetInfo: Cdp.Target.TargetInfo,
    cdp: Cdp.Api,
    parentTarget: BrowserTarget | undefined,
    waitingForDebugger: boolean,
    public readonly launchConfig: AnyChromiumConfiguration,
    public readonly sessionId: string,
    public readonly logger: ILogger,
    ondispose: (t: BrowserTarget) => void,
  ) {
    this._cdp = cdp;
    cdp.pause();

    this.parentTarget = parentTarget;
    this._waitingForDebugger = waitingForDebugger;
    this._updateFromInfo(_targetInfo);
    this._ondispose = ondispose;
  }

  targetOrigin() {
    return this._manager._targetOrigin;
  }

  id(): string {
    return this.sessionId;
  }

  cdp(): Cdp.Api {
    return this._cdp;
  }

  name(): string {
    return this._computeName();
  }

  fileName(): string | undefined {
    return this._targetInfo.url;
  }

  type(): BrowserTargetType {
    return this._targetInfo.type as BrowserTargetType;
  }

  afterBind() {
    this._cdp.resume();
    return Promise.resolve();
  }

  initialize() {
    return Promise.resolve();
  }

  async runIfWaitingForDebugger() {
    await Promise.all([
      this._cdp.Runtime.runIfWaitingForDebugger({}),
      this._cdp.Runtime.evaluate({ expression: signalReadyExpr() }),
    ]);
  }

  parent(): ITarget | undefined {
    if (this.parentTarget && !jsTypes.has(this.parentTarget.type())) {
      return this.parentTarget.parentTarget;
    }
    return this.parentTarget;
  }

  children(): ITarget[] {
    const result: ITarget[] = [];
    for (const target of this._children.values()) {
      if (jsTypes.has(target.type())) result.push(target);
      else result.push(...target.children());
    }
    return result;
  }

  canStop(): boolean {
    return stoppableTypes.has(this.type());
  }

  stop() {
    if (!this._manager.targetList().includes(this)) {
      return;
    }

    if (this.type() === BrowserTargetType.ServiceWorker) {
      // Stop both dedicated and parent service worker scopes for present and future browsers.
      this._manager.serviceWorkerModel.stopWorker(this.id());
      if (!this.parentTarget) return;
      this._manager.serviceWorkerModel.stopWorker(this.parentTarget.id());
    } else {
      this._cdp.Target.closeTarget({ targetId: this._targetInfo.targetId });
    }
  }

  canRestart() {
    return restartableTypes.has(this.type());
  }

  restart() {
    this._cdp.Page.reload({});
  }

  waitingForDebugger(): boolean {
    return this._waitingForDebugger;
  }

  canAttach(): boolean {
    return !this._attached;
  }

  async attach(): Promise<Cdp.Api> {
    this._waitingForDebugger = false;
    this._attached = true;
    return Promise.resolve(this._cdp);
  }

  canDetach(): boolean {
    return this._attached;
  }

  async detach(): Promise<void> {
    this._attached = false;
    this._manager._detachedFromTarget(this.sessionId);
  }

  executionContextName(description: Cdp.Runtime.ExecutionContextDescription): string {
    const auxData = description.auxData;
    const contextName = description.name;
    if (!auxData) return contextName;
    const frameId = auxData['frameId'];
    const frame = frameId ? this._manager.frameModel.frameForId(frameId) : undefined;
    if (frame && auxData['isDefault'] && !frame.parentFrame()) return 'top';
    if (frame && auxData['isDefault']) return frame.displayName();
    if (frame) return `${contextName}`;
    return contextName;
  }

  supportsCustomBreakpoints(): boolean {
    return domDebuggerTypes.has(this.type());
  }

  supportsXHRBreakpoints(): boolean {
    return domDebuggerTypes.has(this.type());
  }

  scriptUrlToUrl(url: string): string {
    return urlUtils.completeUrl(this._targetInfo.url, url) || url;
  }

  _updateFromInfo(targetInfo: Cdp.Target.TargetInfo) {
    // there seems to be a behavior (bug?) in Chrome where the target type is
    // set to 'other' before shutdown which causes us to lose some behavior.
    // Preserve the original type; it should never change (e.g. a page can't
    // become an iframe or a sevice worker).
    this._targetInfo = { ...targetInfo, type: this._targetInfo.type };
    this._onNameChangedEmitter.fire();
  }

  /**
   * Sets a function to compute a custom name for the target.
   * Used to name webviews in js-debug better. Can
   * return undefined to use the default handling.
   */
  public setComputeNameFn(fn: (target: BrowserTarget) => string | undefined) {
    this._customNameComputeFn = fn;
    this._onNameChangedEmitter.fire();
  }

  _computeName(): string {
    const custom = this._customNameComputeFn?.(this);
    if (custom) {
      return custom;
    }
    if (this.type() === BrowserTargetType.ServiceWorker) {
      const version = this._manager.serviceWorkerModel.version(this.id());
      if (version) return version.label() + ' [Service Worker]';
    }

    let threadName = this._targetInfo.title;
    const isAmbiguous = threadName
      && this._manager
        .targetList()
        .some(
          target =>
            target instanceof BrowserTarget
            && target !== this
            && target._targetInfo.title === this._targetInfo.title,
        );

    if (!isAmbiguous) {
      return threadName;
    }

    try {
      const parsedURL = new URL(this._targetInfo.url);
      if (parsedURL.protocol === 'data:') {
        threadName = ' <data>';
      } else if (parsedURL) {
        threadName += ` (${this._targetInfo.url.replace(/^[a-z]+:\/\/|\/$/gi, '')})`;
      } else {
        threadName += ` (${this._targetInfo.url})`;
      }
    } catch (e) {
      threadName += ` (${this._targetInfo.url})`;
    }

    return threadName;
  }

  async _detached() {
    await this._manager.serviceWorkerModel.detached(this._cdp);
    this._ondispose(this);
  }
}
