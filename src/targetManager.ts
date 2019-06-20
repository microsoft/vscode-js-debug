// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Connection, CDPSession } from './connection';
import Protocol from 'devtools-protocol';
import * as debug from 'debug';
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
		this._browserSession.on('Target.targetInfoChanged', event => {
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

	mainTarget(): Target {
		return this._targets.values().next().value;
	}

  target(sequenceNumber: number): Target {
		// TODO(pfeldman): map it.
		return this.targets().find(t => t.threadId() === sequenceNumber);
	}

	_attachToFirstPage() {
		this._browserSession.send('Target.setDiscoverTargets', { discover: true });
		this._browserSession.on('Target.targetCreated', async event => {
			if (this._targets.size)
				return;
			const targetInfo = event.targetInfo;
			if (targetInfo.type !== 'page')
				return;
			const { sessionId } = await this._browserSession.send('Target.attachToTarget', { targetId: targetInfo.targetId, flatten: true }) as { sessionId: Protocol.Target.SessionID };
			this._attachedToTarget(targetInfo, sessionId, false);
		});
		this._browserSession.on('Target.detachedFromTarget', event => {
			const target = this._targets.get(event.targetId);
			if (target)
        this._detachedFromTarget(target);
		});
	}

	_attachedToTarget(targetInfo: Protocol.Target.TargetInfo, sessionId: Protocol.Target.SessionID, waitingForDebugger: boolean): Target {
		const session = this._connection.createSession(sessionId);
		const target = new Target(this, targetInfo, session, waitingForDebugger);
		this._targets.set(targetInfo.targetId, target);
		this.emit(TargetEvents.TargetAttached, target);
		this._dumpTargets();
		return target;
	}

	_detachedFromTarget(target: Target) {
		this.emit(TargetEvents.TargetDetached, target);
		this._targets.delete(target._targetId);
		this._dumpTargets();
	}

  _targetInfoChanged(target: Target) {
		this.emit(TargetEvents.TargetChanged, target);
	}

	_dumpTargets() {
		const target = this.mainTarget();
		if (target)
  		target._dumpTarget();
	}
}

export class Target {
	private _children: Map<Protocol.Target.TargetID, Target> = new Map();
	private _targetManager: TargetManager;
	private _targetInfo: Protocol.Target.TargetInfo;
	_targetId: Protocol.Target.TargetID;
	private _session: CDPSession;
	private static _lastThreadId: number = 0;
	private _threadId = ++Target._lastThreadId;

	constructor(targetManager: TargetManager, targetInfo: Protocol.Target.TargetInfo, session: CDPSession, waitingForDebugger: boolean) {
		this._targetManager = targetManager;
		this._targetInfo = targetInfo;
		this._targetId = targetInfo.targetId;
		this._session = session;
		this._session.send('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: true, flatten: true});
		this._session.on('Target.attachedToTarget', async event => {
			const target = this._targetManager._attachedToTarget(event.targetInfo, event.sessionId, event.waitingForDebugger);
      this._children.set(target._targetId, target);
		});
		this._session.on('Target.detachedFromTarget', async event => {
			const target = this._children.get(event.targetId);
			target._dispose();
		});
		debugTarget(`Attached to ${this._targetInfo.type}: ${this._targetInfo.url}`);

		if (waitingForDebugger)
			this._session.send('Runtime.runIfWaitingForDebugger');
  }

	threadId(): number {
		return this._threadId;
	}

	info(): Protocol.Target.TargetInfo {
		return this._targetInfo;
	}

	session(): CDPSession {
		return this._session;
	}

	_updateFromInfo(targetInfo: Protocol.Target.TargetInfo) {
    this._targetInfo = targetInfo;
		debugTarget(`Target updated ${this._targetInfo.type}: ${this._targetInfo.url}`);
	}

	_dispose() {
		for (const child of this._children.values())
			child._dispose();
		this._targetManager._detachedFromTarget(this);
		this._session.dispose();
		debugTarget(`Detached from ${this._targetInfo.type}: ${this._targetInfo.url}`);
	}

	_dumpTarget(indent: string | undefined = '') {
		debugTarget(`${indent}${this._targetInfo.type} - ${this._targetInfo.url}`);
		for (const child of this._children.values())
			child._dumpTarget(indent + '  ');
	}
}
