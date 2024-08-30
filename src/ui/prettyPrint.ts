/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import * as qs from 'querystring';
import * as vscode from 'vscode';
import { Commands, ContextKey, registerCommand } from '../common/contributionUtils';
import Dap from '../dap/api';
import { IExtensionContribution } from '../ioc-extras';
import { DebugSessionTracker } from './debugSessionTracker';
import { ManagedContextKey } from './managedContextKey';

@injectable()
export class PrettyPrintUI implements IExtensionContribution {
  private readonly canPrettyPrintKey = new ManagedContextKey(ContextKey.CanPrettyPrint);

  constructor(@inject(DebugSessionTracker) private readonly tracker: DebugSessionTracker) {}

  /** @inheritdoc */
  public register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      registerCommand(vscode.commands, Commands.PrettyPrint, () => this.prettifyActive()),
      vscode.window.onDidChangeActiveTextEditor(editor => this.updateEditorState(editor)),
      this.tracker.onSessionAdded(() => this.updateEditorState(vscode.window.activeTextEditor)),
      this.tracker.onSessionEnded(() => this.updateEditorState(vscode.window.activeTextEditor)),
    );
  }

  /**
   * Prettifies the active file in the editor.
   */
  public async prettifyActive() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !this.canPrettyPrint(editor)) {
      return;
    }

    const { sessionId, source } = sourceForUri(editor.document.uri);
    const session = sessionId && this.tracker.getById(sessionId);

    // For ephemeral files, they're attached to a single session, so go ahead
    // and send it to the owning session. For files on disk, send it to all
    // sessions--they will no-op if they don't know about the source.
    if (session) {
      sendPrintCommand(session, source, editor.selection.start);
    } else {
      for (const session of this.tracker.getConcreteSessions()) {
        sendPrintCommand(session, source, editor.selection.start);
      }
    }
  }

  private canPrettyPrint(editor: vscode.TextEditor) {
    return (
      this.tracker.isDebugging
      && editor.document.languageId === 'javascript'
      && !editor.document.fileName.endsWith('-pretty.js')
    );
  }

  private updateEditorState(editor: vscode.TextEditor | undefined) {
    if (!this.tracker.isDebugging) {
      this.canPrettyPrintKey.value = undefined;
      return;
    }

    if (editor && this.canPrettyPrint(editor)) {
      const value = editor.document.uri.toString();
      if (value !== this.canPrettyPrintKey.value?.[0]) {
        this.canPrettyPrintKey.value = [editor.document.uri.toString()];
      }
    }
  }
}

const sendPrintCommand = (
  session: vscode.DebugSession,
  source: Dap.Source,
  cursor: vscode.Position,
) =>
  session.customRequest('prettyPrintSource', {
    source,
    line: cursor.line,
    column: cursor.character,
  });

/**
 * Gets the DAP source and session for a VS Code document URI.
 */
const sourceForUri = (uri: vscode.Uri) => {
  const query = qs.parse(uri.query);
  const sessionId: string | undefined = query['session'] as string;
  const source = {
    path: uri.fsPath,
    sourceReference: Number(query['ref']) || 0,
  };

  return { sessionId, source };
};
