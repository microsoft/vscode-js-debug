// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import { AdapterFactory } from '../adapterFactory';
import { Location } from '../adapter/sources';

let isDebugging = false;
let neverSuggestPrettyPrinting = false;
let prettyPrintedUris: Set<string> = new Set();

export function registerPrettyPrintActions(context: vscode.ExtensionContext, factory: AdapterFactory) {
  context.subscriptions.push(vscode.debug.onDidStartDebugSession(session => updateDebuggingStatus()));
  context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(session => updateDebuggingStatus()));

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(async editor => {
    if (!editor || !isDebugging ||
      editor.document.languageId !== 'javascript' ||
      editor.document.uri.scheme !== 'debug' ||
      neverSuggestPrettyPrinting) {
      return;
    }

    const { source } = await factory.sourceForUri(factory, editor.document.uri);

    // The rest of the code is about suggesting the pretty printing upon editor change.
    // We only want to do it once per document.

    if (prettyPrintedUris.has(editor.document.uri.toString()) ||
      !isMinified(editor.document)) {
      return;
    }

    if (!source || !source.canPrettyPrint())
      return;

    prettyPrintedUris.add(editor.document.uri.toString());
    const response = await vscode.window.showInformationMessage(
      'This JavaScript file seems to be minified.\nWould you like to pretty print it?',
      'Yes', 'No', 'Never');

    if (response === 'Never') {
      neverSuggestPrettyPrinting = true;
      return;
    }

    if (response === 'Yes')
      vscode.commands.executeCommand('pwa.prettyPrint');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('pwa.prettyPrint', async e => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !factory.activeAdapters())
      return;
    const uri = editor.document.uri;
    if (uri.scheme !== 'debug')
      return;
    const { adapter, source } = await factory.sourceForUri(factory, editor.document.uri);
    if (!source || !adapter || !source.canPrettyPrint())
      return;
    const success = await source.prettyPrint();
    if (!success)
      return;

    // Or reveal this source manually.
    const originalLocation: Location = {
      source,
      url: source.url(),
      lineNumber: editor.selection.start.line + 1,
      columnNumber: editor.selection.start.character + 1,
    };
    const newLocation = await adapter.sourceContainer.preferredLocation(originalLocation);
    adapter.sourceContainer.revealLocation(newLocation);
  }));
}

function updateDebuggingStatus() {
  isDebugging = !!vscode.debug.activeDebugSession && vscode.debug.activeDebugSession.type === 'pwa';
  if (!isDebugging)
    prettyPrintedUris.clear();
}

function isMinified(document: vscode.TextDocument): boolean {
  const maxNonMinifiedLength = 500;
  const linesToCheck = 10;
  for (let i = 0; i < linesToCheck && i < document.lineCount; ++i) {
    const line = document.lineAt(i).text;
    if (line.length > maxNonMinifiedLength && !line.startsWith('//#'))
      return true;
  }
  return false;
}
