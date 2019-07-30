// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AdapterFactory } from '../adapterFactory';

export function registerDebugScriptActions(context: vscode.ExtensionContext, factory: AdapterFactory) {
  context.subscriptions.push(vscode.commands.registerCommand('pwa.debugTask', async e => {
    if (!vscode.workspace.workspaceFolders || !vscode.workspace.workspaceFolders.length)
      return;
    const file = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'package.json');
    let data: string;
    try {
      data = JSON.parse(fs.readFileSync(file).toString());
    } catch (e) {
      return;
    }
    const scripts = data['scripts'];
    if (!scripts)
      return;

    const names = Object.keys(scripts);
    const quickPick = vscode.window.createQuickPick();
    quickPick.items = names.map(name => ({ label: name }));
    quickPick.onDidAccept(e => {
      const name = quickPick.selectedItems[0].label;
      debugCommand(scripts[name]);
      quickPick.dispose();
    });
    quickPick.show();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('pwa.debugCurrentScript', async e => {
    const editor = vscode.window.activeTextEditor;
    if (!editor)
      return;
    if (editor.document.languageId !== 'javascript')
      return;
    debugCommand(`node ${editor.document.uri.fsPath}`);
  }));
}

function debugCommand(command: string) {
  vscode.debug.startDebugging(vscode.workspace.workspaceFolders![0], {
    type: 'pwa',
		name: `Debug ${command}`,
    request: 'launch',
    attachToNode: 'always',
    command,
  });
}
