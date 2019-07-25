/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Cdp from '../cdp/api';
import CdpConnection from '../cdp/connection';
import * as debug from 'debug';
import * as path from 'path';
import {URL} from 'url';
import {EventEmitter} from 'events';
import {Thread} from './thread';
import { SourceContainer } from './source';
import Dap from '../dap/api';
const debugTarget = debug('target');

export const TargetEvents = {
  TargetAttached: Symbol('TargetAttached'),
  TargetDetached: Symbol('TargetDetached'),
}

export type PauseOnExceptionsState = 'none' | 'uncaught' | 'all';

export class TargetManager extends EventEmitter {
  private _connection: CdpConnection;
  private _pauseOnExceptionsState: PauseOnExceptionsState;
  private _customBreakpoints: Set<string>;
  private _targets: Map<Cdp.Target.TargetID, Target> = new Map();
  private _mainTarget?: Target;
  private _browser: Cdp.Api;
  private _dap: Dap.Api;
  private _sourceContainer: SourceContainer;
  public threads: Map<number, Thread> = new Map();

  constructor(connection: CdpConnection, dap: Dap.Api, sourceContainer: SourceContainer) {
    super();
    this._connection = connection;
    this._pauseOnExceptionsState = 'none';
    this._customBreakpoints = new Set();
    this._dap = dap;
    this._sourceContainer = sourceContainer;
    this._browser = connection.browser();
    this._attachToFirstPage();
    this._browser.Target.on('targetInfoChanged', event => {
      this._targetInfoChanged(event.targetInfo);
    });
  }

  mainTarget(): Target | undefined {
    return this._mainTarget;
  }

  targets(): Target[] {
    return Array.from(this._targets.values());
  }

  pauseOnExceptionsState(): PauseOnExceptionsState {
    return this._pauseOnExceptionsState;
  }

  setPauseOnExceptionsState(state: PauseOnExceptionsState) {
    this._pauseOnExceptionsState = state;
    for (const thread of this.threads.values())
      thread.updatePauseOnExceptionsState();
  }

  updateCustomBreakpoints(breakpoints: Dap.CustomBreakpoint[]): Promise<any> {
    const promises: Promise<boolean>[] = [];
    for (const breakpoint of breakpoints) {
      if (breakpoint.enabled && !this._customBreakpoints.has(breakpoint.id)) {
        this._customBreakpoints.add(breakpoint.id);
        for (const thread of this.threads.values())
          promises.push(thread.updateCustomBreakpoint(breakpoint.id, true));
      } else if (!breakpoint.enabled && this._customBreakpoints.has(breakpoint.id)) {
        this._customBreakpoints.delete(breakpoint.id);
        for (const thread of this.threads.values())
          promises.push(thread.updateCustomBreakpoint(breakpoint.id, false));
      }
    }
    return Promise.all(promises);
  }

  customBreakpoints(): Set<string> {
    return this._customBreakpoints;
  }

  _attachToFirstPage() {
    this._browser.Target.setDiscoverTargets({ discover: true });
    this._browser.Target.on('targetCreated', async event => {
      if (this._targets.size)
        return;
      const targetInfo = event.targetInfo;
      if (targetInfo.type !== 'page')
        return;
      const response = await this._browser.Target.attachToTarget({ targetId: targetInfo.targetId, flatten: true });
      // TODO(dgozman): handle error.
      if (response)
        this._attachedToTarget(targetInfo, response.sessionId, false);
    });
    this._browser.Target.on('detachedFromTarget', event => {
      // TODO(dgozman): targetId is deprecated, we should use sessionId.
      this._detachedFromTarget(event.targetId!);
    });
  }

  async _attachedToTarget(targetInfo: Cdp.Target.TargetInfo, sessionId: Cdp.Target.SessionID, waitingForDebugger: boolean, parentTarget?: Target) {
    debugTarget(`Attaching to target ${targetInfo.targetId}`);

    const cdp = this._connection.createSession(sessionId);
    const target = new Target(this, this._sourceContainer, targetInfo, cdp, this._dap, parentTarget, target => {
      this._connection.disposeSession(sessionId);
    });
    this._targets.set(targetInfo.targetId, target);
    if (parentTarget)
      parentTarget._children.set(targetInfo.targetId, target);

      cdp.Target.on('attachedToTarget', async event => {
      this._attachedToTarget(event.targetInfo, event.sessionId, event.waitingForDebugger, target);
    });
    cdp.Target.on('detachedFromTarget', async event => {
      // TODO(dgozman): targetId is deprecated, we should use sessionId.
      this._detachedFromTarget(event.targetId!);
    });

    const cleanupOnFailure = () => {
      this._targets.delete(targetInfo.targetId);
      this._connection.disposeSession(sessionId);
    }

    if (!await cdp.Target.setAutoAttach({autoAttach: true, waitForDebuggerOnStart: true, flatten: true}))
      return cleanupOnFailure();
    if (!await target._initialize(waitingForDebugger))
      return cleanupOnFailure();

    if (!this._targets.has(targetInfo.targetId))
      return cleanupOnFailure();
    if (!this._mainTarget)
      this._mainTarget = target;
    this.emit(TargetEvents.TargetAttached, target);
    debugTarget(`Attached to target ${targetInfo.targetId}`);
    this._dumpTargets();
  }

  async _detachedFromTarget(targetId: string) {
    const target = this._targets.get(targetId);
    if (!target)
      return;
    debugTarget(`Detaching from target ${targetId}`);

    for (const childTargetId of target._children.keys())
      await this._detachedFromTarget(childTargetId);
    await target._dispose();

    this._targets.delete(targetId);
    if (target._parentTarget)
      target._parentTarget._children.delete(targetId);

    if (this._mainTarget === target)
      this._mainTarget = undefined;
    this.emit(TargetEvents.TargetDetached, target);
    debugTarget(`Detached from target ${targetId}`);
    this._dumpTargets();
  }

  _targetInfoChanged(targetInfo: Cdp.Target.TargetInfo) {
    const target = this._targets.get(targetInfo.targetId);
    if (!target)
      return;
    target._updateFromInfo(targetInfo);
    this._dumpTargets();
  }

  _dumpTargets() {
    const target = this.mainTarget();
    if (target)
      target._dumpTarget();
  }
}

const jsTypes = new Set(['page', 'iframe', 'worker']);

export class Target {
  private _cdp: Cdp.Api;
  private _thread: Thread | undefined;
  private _targetInfo: Cdp.Target.TargetInfo;
  private _ondispose: (t:Target) => void;

  _parentTarget?: Target;
  _children: Map<Cdp.Target.TargetID, Target> = new Map();

  constructor(targetManager: TargetManager, sourceContainer: SourceContainer, targetInfo: Cdp.Target.TargetInfo, cdp: Cdp.Api, dap: Dap.Api, parentTarget: Target | undefined, ondispose: (t:Target) => void) {
    this._cdp = cdp;
    this._parentTarget = parentTarget;
    if (jsTypes.has(targetInfo.type))
      this._thread = new Thread(targetManager, sourceContainer, cdp, dap);
    this._updateFromInfo(targetInfo);
    this._ondispose = ondispose;
  }

  cdp(): Cdp.Api {
    return this._cdp;
  }

  thread(): Thread | undefined {
    return this._thread;
  }

  targetId(): string {
    return this._targetInfo.targetId;
  }

  async _initialize(waitingForDebugger: boolean): Promise<boolean> {
    if (this._thread && !await this._thread.initialize())
      return false;
    if (waitingForDebugger && !await this._cdp.Runtime.runIfWaitingForDebugger({}))
      return false;
    return true;
  }

  _updateFromInfo(targetInfo: Cdp.Target.TargetInfo) {
    this._targetInfo = targetInfo;
    if (!this._thread)
      return;

    let indentation = '';
    for (let parent = this._parentTarget; parent; parent = parent._parentTarget) {
      if (parent._targetInfo.type === 'service_worker')
        continue;
      indentation += '\u00A0\u00A0\u00A0\u00A0';
    }

    let icon = '';
    if (targetInfo.type === 'page')
      icon = '\uD83D\uDCC4 ';
    else if (targetInfo.type === 'iframe')
      icon = '\uD83D\uDCC4 ';
    else if (targetInfo.type === 'worker')
      icon = '\uD83D\uDC77 ';

    let threadName = indentation + icon;
    try {
      const parsedURL = new URL(targetInfo.url);
      if (parsedURL.pathname === '/')
        threadName += parsedURL.host;
      else
        threadName += parsedURL ? path.basename(parsedURL.pathname) + (parsedURL.hash ? parsedURL.hash : '') : `#${this._thread.threadId()}`;
    } catch (e) {
      threadName += targetInfo.url;
    }

    this._thread.setThreadDetails(threadName, targetInfo.url);
  }

  async _dispose() {
    if (this._thread)
      await this._thread.dispose();
    this._ondispose(this);
  }

  _visit(visitor: (t: Target) => void) {
    visitor(this);
    for (const child of this._children.values())
      child._visit(visitor);
  }

  _dumpTarget(indent: string | undefined = '') {
    debugTarget(`${indent}${this._targetInfo.type} - ${this._targetInfo.url}`);
    for (const child of this._children.values())
      child._dumpTarget(indent + '  ');
  }
}
