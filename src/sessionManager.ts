// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import { DebugAdapter } from './adapter/debugAdapter';
import { Session } from './adapterFactory';
import { BinderDelegate } from './binder';
import { Target } from './targets/targets';

export class SessionManager implements BinderDelegate {
  private _lastPendingSessionId = 0;
  private _pendingSessions = new Map<number, { target: Target, callback: (debugAdapter: DebugAdapter) => void }>();
  private _rootSessions = new Map<string, vscode.DebugSession>();
  private _sessions = new Map<Target, vscode.DebugSession>();
  private _disposable: vscode.Disposable;
  private _sessionForTargetRequests = new Map<Target, { fulfill: (session: vscode.DebugSession) => void, reject: (error: Error) => void}[]>();

  constructor() {
    this._disposable = vscode.debug.onDidTerminateDebugSession(debugSession => this._rootSessions.delete(debugSession.id));
  }

  createSession(context: vscode.ExtensionContext, debugSession: vscode.DebugSession, callback: (debugAdapter: DebugAdapter) => void): Session {
    let session: Session;

    if (debugSession.configuration['__pendingSessionId']) {
      const pendingSessionId = debugSession.configuration['__pendingSessionId'] as number;
      const pendingSession = this._pendingSessions.get(pendingSessionId)!;
      this._pendingSessions.delete(pendingSessionId);
      this._sessions.set(pendingSession.target, debugSession);
      const requests = this._sessionForTargetRequests.get(pendingSession.target);
      if (requests)
        requests.map(request => request.fulfill(debugSession));
      this._sessionForTargetRequests.delete(pendingSession.target);

      session = new Session(context, debugSession, pendingSession.target, undefined, debugAdapter => {
        debugAdapter.dap.on('attach', async () => {
          pendingSession.callback(debugAdapter);
          return {};
        });
        callback(debugAdapter);
      });
    } else {
      session = new Session(context, debugSession, undefined, this, callback);
    }

    this._rootSessions.set(debugSession.id, debugSession);
    return session;
  }

  dispose() {
    this._disposable.dispose();
    this._rootSessions.clear();
    this._sessions.clear();
  }

  async sessionForTarget(target: Target): Promise<vscode.DebugSession> {
    const result = this._sessions.get(target);
    if (result)
      return result;
    return new Promise((fulfill, reject) => {
      let requests = this._sessionForTargetRequests.get(target);
      if (!requests) {
        requests = [];
        this._sessionForTargetRequests.set(target, requests);
      }
      requests.push({ fulfill, reject });
    });
  }

  acquireDebugAdapter(target: Target): Promise<DebugAdapter> {
    return new Promise<DebugAdapter>(async callback => {
      const pendingSessionId = ++this._lastPendingSessionId;
      this._pendingSessions.set(pendingSessionId, { target, callback });
      const rootSession = this._rootSessions.get(target.targetOrigin() as string)!;
      const parentSession = target.parent() ? await this.sessionForTarget(target.parent()!) : undefined;
      const config = {
        type: 'pwa',
        name: target.name(),
        request: 'attach',
        __pendingSessionId: pendingSessionId,
        sessionPerThread: true
      };
      vscode.debug.startDebugging(rootSession.workspaceFolder, config, parentSession || rootSession);
    });
  }

  releaseDebugAdapter(target: Target, debugAdapter: DebugAdapter) {
    // One adapter per thread, we can remove it when removing the thread.
    debugAdapter.dap.terminated({});
    this._sessions.delete(target);
    for (const request of this._sessionForTargetRequests.get(target) || [])
      request.reject(new Error('Target gone'));
  }
}
