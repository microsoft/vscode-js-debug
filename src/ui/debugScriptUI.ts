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
    const data = await new Promise<Buffer>(f => fs.readFile(file, (err: NodeJS.ErrnoException, buf: Buffer) => f(buf)));
    let json: any = undefined;
    try {
      json = JSON.parse(data.toString());
    } catch (e) {
    }
    if (!json || !json['scripts'])
      return;

    const names = Object.keys(json['scripts']);
    const quickPick = vscode.window.createQuickPick();
    quickPick.items = names.map(name => ({ label: name }));
    quickPick.onDidAccept(e => {
      const name = quickPick.selectedItems[0].label;
      debugCommand(json!['scripts'][name]);
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

  context.subscriptions.push(vscode.commands.registerCommand('pwa.createDebuggerTerminal', async e => {
    vscode.debug.startDebugging(vscode.workspace.workspaceFolders![0], {
      type: 'pwa',
      name: 'Debugger terminal',
      request: 'launch',
      command: ''
    });
  }));
}

function debugCommand(command: string) {
  vscode.debug.startDebugging(vscode.workspace.workspaceFolders![0], {
    type: 'pwa',
		name: `Debug ${command}`,
    request: 'launch',
    command,
  });
}
