import { Connection, CDPSession } from './connection';
import Protocol from 'devtools-protocol';
import * as debug from 'debug';
import * as path from 'path';
import { URL } from 'url';
import { EventEmitter } from 'events';
import {Thread} from './thread';
import ProtocolProxyApi from 'devtools-protocol/types/protocol-proxy-api';
const debugTarget = debug('target');

export const TargetEvents = {
  TargetAttached: Symbol('TargetAttached'),
  TargetDetached: Symbol('TargetDetached'),
}

export class TargetManager extends EventEmitter {
  private _connection: Connection;
  private _targets: Map<Protocol.Target.TargetID, Target> = new Map();
  private _browser: ProtocolProxyApi.ProtocolApi;

  constructor(connection: Connection) {
    super();
    this._connection = connection;
    this._browser = connection.browserSession().cdp();
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

  async _attachedToTarget(targetInfo: Protocol.Target.TargetInfo, sessionId: Protocol.Target.SessionID, waitingForDebugger: boolean, parentTarget: Target|null) {
    debugTarget(`Attaching to target ${targetInfo.targetId}`);

    const session = this._connection.createSession(sessionId);
    const cdp = session.cdp();
    const target = new Target(targetInfo, session, parentTarget);
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
    target._session.dispose();

    this._targets.delete(targetId);
    if (target._parentTarget)
      target._parentTarget._children.delete(targetId);

    this.emit(TargetEvents.TargetDetached, target);
    debugTarget(`Detached from target ${targetId}`);
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
  private _cdp: ProtocolProxyApi.ProtocolApi;
  private _thread: Thread | undefined;
  private _targetInfo: Protocol.Target.TargetInfo;

  _session: CDPSession;
  _parentTarget?: Target;
  _children: Map<Protocol.Target.TargetID, Target> = new Map();

  constructor(targetInfo: Protocol.Target.TargetInfo, session: CDPSession, parentTarget: Target | undefined) {
    this._session = session;
    this._cdp = session.cdp();
    this._parentTarget = parentTarget;
    if (jsTypes.has(targetInfo.type))
      this._thread = new Thread(this);
    this._updateFromInfo(targetInfo);
  }

  thread(): Thread | undefined {
    return this._thread;
  }

  cdp(): ProtocolProxyApi.ProtocolApi {
    return this._cdp;
  }

  async _initialize(waitingForDebugger: boolean) {
    if (this._thread)
      await this._thread.initialize();
    if (waitingForDebugger)
      await this._cdp.Runtime.runIfWaitingForDebugger();
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

  async _dispose() {
    if (this._thread)
      await this._thread.dispose();
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
