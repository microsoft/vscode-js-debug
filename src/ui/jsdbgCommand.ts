/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { Commands } from '../common/contributionUtils';

/**
 * Registers the jsdbg command terminal integration.
 * This allows users to run `jsdbg node myScript.js` in any terminal
 * to start a debug session, similar to the JavaScript Debug Terminal.
 */
export function registerJsdbgCommand(context: vscode.ExtensionContext) {
  // Listen for command executions in all terminals
  context.subscriptions.push(
    vscode.window.onDidStartTerminalShellExecution(async event => {
      const commandLine = event.execution.commandLine;
      if (!commandLine || typeof commandLine.value !== 'string') {
        return;
      }

      const command = commandLine.value.trim();
      
      // Check if the command starts with jsdbg
      if (command.startsWith('jsdbg ')) {
        // Extract the actual command to debug
        const actualCommand = command.substring('jsdbg '.length).trim();
        
        if (!actualCommand) {
          vscode.window.showErrorMessage('Usage: jsdbg <command>');
          return;
        }

        // Get the current working directory from the terminal
        const cwd = await getTerminalCwd(event.terminal);

        // Create a JavaScript Debug Terminal with the command
        await vscode.commands.executeCommand(
          Commands.CreateDebuggerTerminal,
          actualCommand,
          cwd ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd)) : undefined,
          cwd ? { cwd } : undefined
        );
      }
    })
  );
}

/**
 * Attempts to get the current working directory of a terminal.
 */
async function getTerminalCwd(terminal: vscode.Terminal): Promise<string | undefined> {
  // Try to get the CWD from shell integration
  const shellIntegration = terminal.shellIntegration;
  if (shellIntegration && shellIntegration.cwd) {
    return shellIntegration.cwd.fsPath;
  }

  // Fallback to workspace folder
  const folders = vscode.workspace.workspaceFolders;
  return folders?.[0]?.uri.fsPath;
}
