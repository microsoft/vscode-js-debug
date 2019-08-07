// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import { DebugAdapter } from './adapter/debugAdapter';
import { Session } from './adapterFactory';
import { BinderDelegate } from './binder';
import { Target } from './targets/targets';

export class SessionManager implements BinderDelegate {
  private _lastPendingSessionId = 0;
  private _pendingSessionCallbacks = new Map<number, (debugAdapter: DebugAdapter) => void>();
  private _sessions = new Map<string, vscode.DebugSession>();
  private _disposable: vscode.Disposable;

  constructor() {
    this._disposable = vscode.debug.onDidTerminateDebugSession(debugSession => this._sessions.delete(debugSession.id));
  }

  createSession(context: vscode.ExtensionContext, debugSession: vscode.DebugSession, callback: (debugAdapter: DebugAdapter) => void): Session {
    let session: Session;

    if (debugSession.configuration['__pendingSessionId']) {
      const pendingSessionId = debugSession.configuration['__pendingSessionId'] as number;
      session = new Session(context, debugSession, undefined, debugAdapter => {
        debugAdapter.dap.on('attach', async () => {
          const pendingSessionCallback = this._pendingSessionCallbacks.get(pendingSessionId);
          this._pendingSessionCallbacks.delete(pendingSessionId);
          if (pendingSessionCallback)
            pendingSessionCallback(debugAdapter);
          return {};
        });
        callback(debugAdapter);
      });
    } else {
      session = new Session(context, debugSession, this, callback);
    }

    this._sessions.set(debugSession.id, debugSession);
    return session;
  }

  dispose() {
    this._disposable.dispose();
    this._sessions.clear();
  }

  acquireDebugAdapter(target: Target): Promise<DebugAdapter> {
    return new Promise<DebugAdapter>(callback => {
      const pendingSessionId = ++this._lastPendingSessionId;
      this._pendingSessionCallbacks.set(pendingSessionId, callback);
      const rootSession = this._sessions.get(target.targetOrigin() as string)!;
      const config = {
        type: 'pwa',
        name: target.name(),
        request: 'attach',
        __pendingSessionId: pendingSessionId,
        sessionPerThread: true
      };
      vscode.debug.startDebugging(rootSession.workspaceFolder, config, rootSession);
    });
  }

  releaseDebugAdapter(debugAdapter: DebugAdapter) {
    // One adapter per thread, we can remove it when removing the thread.
    debugAdapter.dap.terminated({});
  }
}
