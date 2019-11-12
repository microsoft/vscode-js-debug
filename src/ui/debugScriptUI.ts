/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { Contributions } from '../common/contributionUtils';

export function registerDebugScriptActions(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(Contributions.CreateDebuggerTerminal, async e => {
      vscode.debug.startDebugging(vscode.workspace.workspaceFolders![0], {
        type: Contributions.TerminalDebugType,
        name: 'Debugger Terminal',
        request: 'launch',
      });
    }),
  );
}
