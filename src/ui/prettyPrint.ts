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
    let prettied: { session: vscode.DebugSession; result: Dap.PrettyPrintSourceResult }[];
    if (session) {
      prettied = [{
        session,
        result: await sendPrintCommand(session, source, editor.selection.start),
      }];
    } else {
      prettied = await Promise.all(
        this.tracker.getConcreteSessions().map(async session => {
          const result = await sendPrintCommand(session, source, editor.selection.start);
          return { session, result };
        }),
      );
    }

    if (!prettied.some(p => p.result.didReveal)) {
      const reveal = prettied.find(p => p.result.source);
      if (reveal) {
        const doc = await vscode.workspace.openTextDocument(
          dapSourceToDebugUri(reveal.session, reveal.result.source!),
        );
        await vscode.window.showTextDocument(doc);
      }
    }
  }

  private canPrettyPrint(editor: vscode.TextEditor) {
    return (
      this.tracker.isDebugging
      && editor.document.languageId === 'javascript'
      && !editor.document.uri.path.endsWith('-pretty.js')
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
): Thenable<Dap.PrettyPrintSourceResult> =>
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

// https://github.com/microsoft/vscode/blob/7f9c7a41873b88861744d06aed33d2dbcaa3a92e/src/vs/workbench/contrib/debug/common/debugSource.ts#L132
const dapSourceToDebugUri = (session: vscode.DebugSession, source: Dap.Source) => {
  if (!source.sourceReference) {
    return vscode.Uri.file(source.path || '');
  }

  return vscode.Uri.from({
    scheme: 'debug',
    path: source.path?.replace(/^\/+/g, '/'), // #174054
    query: `session=${session.id}&ref=${source.sourceReference}`,
  });
};
