// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';

export class DebugSessionTracker implements vscode.Disposable {
  private _onSessionAddedEmitter = new vscode.EventEmitter<vscode.DebugSession>();
  private _disposables: vscode.Disposable[] = [];

  public sessions = new Map<string, vscode.DebugSession>();
  public onSessionAdded = this._onSessionAddedEmitter.event;

  constructor() {
    vscode.debug.onDidStartDebugSession(session => {
      if (session.type === 'pwa') {
        this.sessions.set(session.id, session);
        this._onSessionAddedEmitter.fire(session);
      }
    }, undefined, this._disposables);

    vscode.debug.onDidTerminateDebugSession(session => {
      this.sessions.delete(session.id);
    }, undefined, this._disposables);
  }

  dispose() {
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables = [];
  }
}
