/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import Dap from '../dap/api';
import { isDebugType } from '../common/contributionUtils';
import { injectable } from 'inversify';

/**
 * Keeps a list of known js-debug sessions.
 */
@injectable()
export class DebugSessionTracker implements vscode.Disposable {
  private _onSessionAddedEmitter = new vscode.EventEmitter<vscode.DebugSession>();
  private _disposables: vscode.Disposable[] = [];

  public sessions = new Map<string, vscode.DebugSession>();
  public onSessionAdded = this._onSessionAddedEmitter.event;

  public attach() {
    vscode.debug.onDidStartDebugSession(
      session => {
        if (session.configuration.__pendingTargetId) {
          this.sessions.set(session.id, session);
          this._onSessionAddedEmitter.fire(session);
        }
      },
      undefined,
      this._disposables,
    );

    vscode.debug.onDidTerminateDebugSession(
      session => {
        this.sessions.delete(session.id);
      },
      undefined,
      this._disposables,
    );

    vscode.debug.onDidReceiveDebugSessionCustomEvent(
      event => {
        if (!isDebugType(event.session.type)) {
          return;
        }

        if (event.event === 'revealLocationRequested') {
          const params = event.body as Dap.RevealLocationRequestedEventParams;
          const uri = vscode.debug.asDebugSourceUri(event.body.source);
          const options: vscode.TextDocumentShowOptions = {};
          if (params.line) {
            const position = new vscode.Position((params.line || 1) - 1, (params.column || 1) - 1);
            options.selection = new vscode.Range(position, position);
          }
          vscode.window.showTextDocument(uri, options);
          return;
        }

        if (event.event === 'copyRequested') {
          const params = event.body as Dap.CopyRequestedEventParams;
          vscode.env.clipboard.writeText(params.text);
          return;
        }
      },
      undefined,
      this._disposables,
    );
  }

  dispose() {
    for (const disposable of this._disposables) disposable.dispose();
    this._disposables = [];
  }
}
