// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {Cdp, CdpApi} from '../cdp/api';
import {Connection} from '../cdp/connection';
import * as debug from 'debug';
import * as path from 'path';
import {URL} from 'url';
import {EventEmitter} from 'events';
import {Thread} from './thread';
import {SourceContainer} from './source';
const debugTarget = debug('target');

export const TargetEvents = {
  TargetAttached: Symbol('TargetAttached'),
  TargetDetached: Symbol('TargetDetached'),
}

export class TargetManager extends EventEmitter {
  private _connection: Connection;
  private _targets: Map<Cdp.Target.TargetID, Target> = new Map();
  private _browser: CdpApi;
  private _sourceContainer: SourceContainer;

  constructor(connection: Connection, sourceContainer: SourceContainer) {
    super();
    this._connection = connection;
    this._sourceContainer = sourceContainer;
    this._browser = connection.browser();
    this._attachToFirstPage();
    this._browser.Target.on('targetInfoChanged', event => {
      this._targetInfoChanged(event.targetInfo);
    });
  }

  targets(): Target[] {
    return Array.from(this._targets.values());
  }

  mainTarget(): Target {
    return this._targets.values().next().value;
  }

  _attachToFirstPage() {
    this._browser.Target.setDiscoverTargets({ discover: true });
    this._browser.Target.on('targetCreated', async event => {
      if (this._targets.size)
        return;
      const targetInfo = event.targetInfo;
      if (targetInfo.type !== 'page')
        return;
      const { sessionId } = await this._browser.Target.attachToTarget({ targetId: targetInfo.targetId, flatten: true });
      this._attachedToTarget(targetInfo, sessionId, false, null);
    });
    this._browser.Target.on('detachedFromTarget', event => {
      this._detachedFromTarget(event.targetId);
    });
  }

  async _attachedToTarget(targetInfo: Cdp.Target.TargetInfo, sessionId: Cdp.Target.SessionID, waitingForDebugger: boolean, parentTarget: Target|null) {
    debugTarget(`Attaching to target ${targetInfo.targetId}`);

    const cdp = this._connection.createSession(sessionId);
    const target = new Target(targetInfo, cdp, parentTarget, this._sourceContainer, target => {
      this._connection.disposeSession(sessionId);
    });
    this._targets.set(targetInfo.targetId, target);
    if (parentTarget)
      parentTarget._children.set(targetInfo.targetId, target);

      cdp.Target.on('attachedToTarget', async event => {
      this._attachedToTarget(event.targetInfo, event.sessionId, event.waitingForDebugger, target);
    });
    cdp.Target.on('detachedFromTarget', async event => {
      this._detachedFromTarget(event.targetId);
    });
    await cdp.Target.setAutoAttach({autoAttach: true, waitForDebuggerOnStart: true, flatten: true});
    await target._initialize(waitingForDebugger);

    if (!this._targets.has(targetInfo.targetId))
      return;
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
  private _cdp: CdpApi;
  private _thread: Thread | undefined;
  private _targetInfo: Cdp.Target.TargetInfo;
  private _sourceContainer: SourceContainer;
  private _ondispose: (t:Target) => void;

  _parentTarget?: Target;
  _children: Map<Cdp.Target.TargetID, Target> = new Map();

  constructor(targetInfo: Cdp.Target.TargetInfo, cdp: CdpApi, parentTarget: Target | undefined, sourceContainer: SourceContainer, ondispose: (t:Target) => void) {
    this._cdp = cdp;
    this._parentTarget = parentTarget;
    this._sourceContainer = sourceContainer;
    if (jsTypes.has(targetInfo.type))
      this._thread = new Thread(this);
    this._updateFromInfo(targetInfo);
    this._ondispose = ondispose;
  }

  thread(): Thread | undefined {
    return this._thread;
  }

  cdp(): CdpApi {
    return this._cdp;
  }

  url(): string {
    return this._targetInfo.url;
  }

  sourceContainer(): SourceContainer {
    return this._sourceContainer;
  }

  async _initialize(waitingForDebugger: boolean) {
    if (this._thread)
      await this._thread.initialize();
    if (waitingForDebugger)
      await this._cdp.Runtime.runIfWaitingForDebugger();
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

    this._thread.setThreadName(threadName);
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
