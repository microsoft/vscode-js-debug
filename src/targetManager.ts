// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Connection, CDPSession } from './connection';
import Protocol from 'devtools-protocol';
import * as debug from 'debug';
import * as path from 'path';
import { URL } from 'url';
import { EventEmitter } from 'events';
import {Thread} from './thread';
const debugTarget = debug('target');

export const TargetEvents = {
  TargetAttached: Symbol('TargetAttached'),
  TargetDetached: Symbol('TargetDetached'),
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
    this._browserSession.on('Target.targetInfoChanged', (event: Protocol.Target.TargetInfoChangedEvent) => {
      this._targetInfoChanged(event.targetInfo);
    });
  }

  targets(): Target[] {
    return Array.from(this._targets.values());
  }

  threads(): Thread[] {
    const mainTarget = this.mainTarget();
    if (!mainTarget)
      return [];

    const result: Thread[] = [];
    mainTarget._visit(t => t.thread() ? result.push(t.thread()) : 0);
    return result;
  }

  mainTarget(): Target {
    return this._targets.values().next().value;
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

  _targetInfoChanged(targetInfo: Protocol.Target.TargetInfo) {
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
  private _children: Map<Protocol.Target.TargetID, Target> = new Map();
  private _targetManager: TargetManager;
  _targetInfo: Protocol.Target.TargetInfo;
  _targetId: Protocol.Target.TargetID;
  private _session: CDPSession;
  private _parentTarget?: Target;
  _thread: Thread | undefined;

  constructor(targetManager: TargetManager, targetInfo: Protocol.Target.TargetInfo, session: CDPSession, waitingForDebugger: boolean, parentTarget: Target | undefined) {
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

    if (jsTypes.has(targetInfo.type))
      this._thread = new Thread(this);
    this._updateFromInfo(targetInfo);

    debugTarget(`Attached to ${this._targetInfo.title}`);
    this._initialize(waitingForDebugger);
  }

  thread(): Thread | undefined {
    return this._thread;
  }

  session(): CDPSession {
    return this._session;
  }

  async _initialize(waitingForDebugger: boolean) {
    if (this._thread)
      await this._thread.initialize();
    if (waitingForDebugger)
      this._session.send('Runtime.runIfWaitingForDebugger');
  }

  _updateFromInfo(targetInfo: Protocol.Target.TargetInfo) {
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

  _dispose() {
    for (const child of this._children.values())
      child._dispose();
    if (this._thread)
      this._thread.dispose();
    this._targetManager._detachedFromTarget(this);
    this._session.dispose();
    debugTarget(`Detached from ${this._targetInfo.title}`);
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
