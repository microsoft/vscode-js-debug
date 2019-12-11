/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import * as queryString from 'querystring';
import Dap from '../dap/api';
import { DebugSessionTracker } from './debugSessionTracker';
import { Contributions } from '../common/contributionUtils';

let isDebugging = false;
let neverSuggestPrettyPrinting = false;
const prettyPrintedUris: Set<string> = new Set();

export function registerPrettyPrintActions(
  context: vscode.ExtensionContext,
  debugSessionTracker: DebugSessionTracker,
) {
  context.subscriptions.push(vscode.debug.onDidStartDebugSession(() => updateDebuggingStatus()));
  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession(() => updateDebuggingStatus()),
  );

  function sourceForUri(uri: vscode.Uri): { session?: vscode.DebugSession; source: Dap.Source } {
    const query = queryString.parse(uri.query);
    const sessionId = query['session'] as string;
    const source: Dap.Source = {
      path: uri.path,
      sourceReference: +(query['ref'] as string),
    };
    return { session: debugSessionTracker.sessions.get(sessionId), source };
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async editor => {
      if (
        !editor ||
        !isDebugging ||
        editor.document.languageId !== 'javascript' ||
        editor.document.uri.scheme !== 'debug' ||
        neverSuggestPrettyPrinting
      ) {
        return;
      }

      //const { source } = await factory.sourceForUri(editor.document.uri);

      // The rest of the code is about suggesting the pretty printing upon editor change.
      // We only want to do it once per document.

      if (prettyPrintedUris.has(editor.document.uri.toString()) || !isMinified(editor.document)) {
        return;
      }

      const { session, source } = sourceForUri(editor.document.uri);
      if (!session) return;
      const canPrettyPrintResponse = await session.customRequest('canPrettyPrintSource', {
        source,
      });
      if (!canPrettyPrintResponse || !canPrettyPrintResponse.canPrettyPrint) return;

      prettyPrintedUris.add(editor.document.uri.toString());
      const response = await vscode.window.showInformationMessage(
        'This JavaScript file seems to be minified.\nWould you like to pretty print it?',
        'Yes',
        'No',
        'Never',
      );

      if (response === 'Never') {
        neverSuggestPrettyPrinting = true;
        return;
      }

      if (response === 'Yes') vscode.commands.executeCommand(Contributions.PrettyPrintCommand);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(Contributions.PrettyPrintCommand, async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const uri = editor.document.uri;
      if (uri.scheme !== 'debug') return;
      const { session, source } = sourceForUri(editor.document.uri);
      if (session)
        session.customRequest('prettyPrintSource', {
          source,
          line: editor.selection.start.line + 1,
          column: editor.selection.start.character + 1,
        });
    }),
  );
}

function updateDebuggingStatus() {
  isDebugging = !!vscode.debug.activeDebugSession && vscode.debug.activeDebugSession.type === 'pwa';
  if (!isDebugging) prettyPrintedUris.clear();
}

function isMinified(document: vscode.TextDocument): boolean {
  const maxNonMinifiedLength = 500;
  const linesToCheck = 10;
  for (let i = 0; i < linesToCheck && i < document.lineCount; ++i) {
    const line = document.lineAt(i).text;
    if (line.length > maxNonMinifiedLength && !line.startsWith('//#')) return true;
  }
  return false;
}
