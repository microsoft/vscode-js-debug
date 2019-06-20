import { Connection, CDPSession } from './connection';
import Protocol from 'devtools-protocol';
import * as debug from 'debug';
const debugTarget = debug('target');

export class TargetManager {
	private _connection: Connection;
	private _targets: Map<Protocol.Target.TargetID, Target> = new Map();
	private _browserSession: CDPSession;

	constructor(connection: Connection) {
		this._connection = connection;
		this._browserSession = connection.browserSession();
		this._attachToFirstPage();
		this._browserSession.on('Target.targetInfoChanged', event => {
			const target = this._targets.get(event.targetInfo.targetId);
			if (target)
  			target._updateFromInfo(event.targetInfo);
		});
	}

	_attachToFirstPage() {
		this._browserSession.send('Target.setDiscoverTargets', { discover: true });
		this._browserSession.on('Target.targetCreated', event => {
			if (this._targets.size)
				return;
			if (event.targetInfo.type !== 'page')
				return;
		  this._attachToTarget(event.targetInfo);
		});
	}

	async _attachToTarget(targetInfo: Protocol.Target.TargetInfo) {
    const { sessionId } = await this._browserSession.send('Target.attachToTarget', { targetId: targetInfo.targetId, flatten: true }) as { sessionId: string };
    const session = this._connection.session(sessionId);
		this._targets.set(targetInfo.targetId, new Target(this, targetInfo, session));
  }

	_attachedToTarget(targetInfo: Protocol.Target.TargetInfo, sessionId: Protocol.Target.SessionID): Target {
		const session = this._connection.session(sessionId);
		const target = new Target(this, targetInfo, session);
		this._targets.set(targetInfo.targetId, target);
		return target;
	}

	_detachedFromTarget(targetId: Protocol.Target.TargetID) {
		const target = this._targets.get(targetId);
		if (target)
		  target._dispose();
		this._targets.delete(targetId);
	}
}

export class Target {
	private _targetManager: TargetManager;
	private _targetInfo: Protocol.Target.TargetInfo;
	private _session: CDPSession;

	constructor(targetManager: TargetManager, targetInfo: Protocol.Target.TargetInfo, session: CDPSession) {
		this._targetManager = targetManager;
		this._targetInfo = targetInfo;
		this._session = session;
		this._session.send('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: true, flatten: true});
		this._session.on('Target.attachedToTarget', async event => {
			this._targetManager._attachedToTarget(event.targetInfo, event.sessionId);
			if (event.waitingForDebugger)
			  this._session.send('Runtime.runIfWaitingForDebugger');
		});
		this._session.on('Target.detachedFromTarget', async event => {
      this._targetManager._detachedFromTarget(event.targetId);
		});
		console.log(`Attached to ${this._targetInfo.type}: ${this._targetInfo.url}`);
	}

	_updateFromInfo(targetInfo: Protocol.Target.TargetInfo) {
    this._targetInfo = targetInfo;
		console.log(`Target updated ${this._targetInfo.type}: ${this._targetInfo.url}`);
	}

	_dispose() {
		console.log(`Detached from ${this._targetInfo.type}: ${this._targetInfo.url}`);
	}
}
