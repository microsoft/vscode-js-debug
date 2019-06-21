// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Connection, CDPSession } from './connection';
import Protocol from 'devtools-protocol';
import * as debug from 'debug';
import * as path from 'path';
import { URL } from 'url';
import { EventEmitter } from 'events';
const debugTarget = debug('target');

export const TargetEvents = {
  TargetAttached: Symbol('TargetAttached'),
  TargetDetached: Symbol('TargetDetached'),
  TargetChanged: Symbol('TargetChanged'),
}

export class TargetManager extends EventEmitter {
  private _connection: Connection;
  private _targets: Map<Protocol.Target.TargetID, Target> = new Map();
  private _browserSession: CDPSession;

  constructor(connection: Connection) {
    super();
    this._connection = connection;
    this._browserSession = connection.browserSession();
    this._attachToFirstPage();
    this._browserSession.on('Target.targetInfoChanged', (event: Protocol.Target.TargetInfoChangedEvent)=> {
      const target = this._targets.get(event.targetInfo.targetId);
      if (target) {
        target._updateFromInfo(event.targetInfo);
        this._targetInfoChanged(target);
      }
    });
  }

  targets(): Target[] {
    return Array.from(this._targets.values());
  }

  threadTargets(): Target[] {
    const mainTarget = this.mainTarget();
    if (!mainTarget)
      return [];

    const result: Target[] = [];
    mainTarget._visit(t => t.threadId() ? result.push(t) : 0);
    return result;
  }

  mainTarget(): Target {
    return this._targets.values().next().value;
  }

  target(sequenceNumber: number): Target {
    // TODO(pfeldman): map it.
    return this.targets().find(t => t.threadId() === sequenceNumber);
  }

  _attachToFirstPage() {
    this._browserSession.send('Target.setDiscoverTargets', { discover: true });
    this._browserSession.on('Target.targetCreated', async (event: Protocol.Target.TargetCreatedEvent) => {
      if (this._targets.size)
        return;
      const targetInfo = event.targetInfo;
      if (targetInfo.type !== 'page')
        return;
      const { sessionId } = await this._browserSession.send('Target.attachToTarget', { targetId: targetInfo.targetId, flatten: true }) as { sessionId: Protocol.Target.SessionID };
      this._attachedToTarget(targetInfo, sessionId, false, null);
    });
    this._browserSession.on('Target.detachedFromTarget', (event: Protocol.Target.DetachedFromTargetEvent) => {
      const target = this._targets.get(event.targetId);
      if (target)
        this._detachedFromTarget(target);
    });
  }

  _attachedToTarget(targetInfo: Protocol.Target.TargetInfo, sessionId: Protocol.Target.SessionID, waitingForDebugger: boolean, parentTarget: Target|null): Target {
    const session = this._connection.createSession(sessionId);
    const target = new Target(this, targetInfo, session, waitingForDebugger, parentTarget);
    this._targets.set(targetInfo.targetId, target);
    this.emit(TargetEvents.TargetAttached, target);
    this._dumpTargets();
    return target;
  }

  _detachedFromTarget(target: Target) {
    this._targets.delete(target._targetId);
    this.emit(TargetEvents.TargetDetached, target);
    this._dumpTargets();
  }

  _targetInfoChanged(target: Target) {
    this.emit(TargetEvents.TargetChanged, target);
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
  private _children: Map<Protocol.Target.TargetID, Target> = new Map();
  private _targetManager: TargetManager;
  private _targetInfo: Protocol.Target.TargetInfo;
  _targetId: Protocol.Target.TargetID;
  private _session: CDPSession;
  private static _lastThreadId: number = 0;
  private _threadId = ++Target._lastThreadId;
  private _threadName: string;
  private _parentTarget: Target | null;

  constructor(targetManager: TargetManager, targetInfo: Protocol.Target.TargetInfo, session: CDPSession, waitingForDebugger: boolean, parentTarget: Target | null) {
    this._targetManager = targetManager;
    this._targetId = targetInfo.targetId;
    this._session = session;
    this._session.send('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: true, flatten: true});
    this._session.on('Target.attachedToTarget', async (event: Protocol.Target.AttachedToTargetEvent) => {
      const target = this._targetManager._attachedToTarget(event.targetInfo, event.sessionId, event.waitingForDebugger, this);
      this._children.set(target._targetId, target);
    });
    this._session.on('Target.detachedFromTarget', async (event: Protocol.Target.DetachedFromTargetEvent) => {
      const target = this._children.get(event.targetId);
      this._children.delete(target._targetId);
      target._dispose();
    });
    this._parentTarget = parentTarget;

    this._threadId = jsTypes.has(targetInfo.type) ? ++Target._lastThreadId : 0;
    this._updateFromInfo(targetInfo);

    debugTarget(`Attached to ${this._threadName}`);
    this._initialize(waitingForDebugger);
  }

  threadId(): number {
    return this._threadId;
  }

  threadName(): string {
    return this._threadName;
  }

  session(): CDPSession {
    return this._session;
  }

  async _initialize(waitingForDebugger: boolean) {
    await this._session.send('Runtime.enable');
    if (waitingForDebugger)
      this._session.send('Runtime.runIfWaitingForDebugger');
  }

  _updateFromInfo(targetInfo: Protocol.Target.TargetInfo) {
    this._targetInfo = targetInfo;

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
        threadName += parsedURL ? path.basename(parsedURL.pathname) + (parsedURL.hash ? parsedURL.hash : '') : `#${this._threadId}`;
    } catch (e) {
      threadName += targetInfo.url;
    }
    this._threadName = threadName;
    debugTarget(`Target updated ${this._threadName}`);
  }

  _dispose() {
    for (const child of this._children.values())
      child._dispose();
    this._targetManager._detachedFromTarget(this);
    this._session.dispose();
    debugTarget(`Detached from ${this._threadName}`);
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
