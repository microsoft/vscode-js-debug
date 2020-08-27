/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable } from 'inversify';
import * as vscode from 'vscode';
import { isDebugType } from '../common/contributionUtils';
import Dap from '../dap/api';

/**
 * Keeps a list of known js-debug sessions.
 */
@injectable()
export class DebugSessionTracker implements vscode.Disposable {
  /**
   * Returns whether the session is a concrete debug
   * session -- that is, not a logical session wrapper.
   */
  public static isConcreteSession(session: vscode.DebugSession) {
    return !!session.configuration.__pendingTargetId;
  }

  private _onSessionAddedEmitter = new vscode.EventEmitter<vscode.DebugSession>();
  private _onSessionEndedEmitter = new vscode.EventEmitter<vscode.DebugSession>();
  private _disposables: vscode.Disposable[] = [];
  private readonly sessions = new Map<string, vscode.DebugSession>();

  /**
   * Fires when any new js-debug session comes in.
   */
  public onSessionAdded = this._onSessionAddedEmitter.event;

  /**
   * Fires when any js-debug session ends.
   */
  public onSessionEnded = this._onSessionEndedEmitter.event;

  /**
   * Returns the session with the given ID.
   */
  public getById(id: string) {
    return this.sessions.get(id);
  }

  /**
   * Returns a list of sessions with the given debug session name.
   */
  public getByName(name: string) {
    return [...this.sessions.values()].filter(s => s.name === name);
  }

  /**
   * Gets physical debug sessions -- that is, avoids the logical session wrapper.
   */
  public getConcreteSessions() {
    return [...this.sessions.values()].filter(DebugSessionTracker.isConcreteSession);
  }

  public attach() {
    vscode.debug.onDidStartDebugSession(
      session => {
        if (isDebugType(session.type)) {
          this.sessions.set(session.id, session);
          this._onSessionAddedEmitter.fire(session);
        }
      },
      undefined,
      this._disposables,
    );

    vscode.debug.onDidTerminateDebugSession(
      session => {
        if (isDebugType(session.type)) {
          this.sessions.delete(session.id);
          this._onSessionEndedEmitter.fire(session);
        }
      },
      undefined,
      this._disposables,
    );

    // todo: move this into its own class
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
