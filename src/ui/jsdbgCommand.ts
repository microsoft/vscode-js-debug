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
      
      // Check if the command starts with jsdbg (case-sensitive)
      // Match "jsdbg " or "jsdbg" followed by whitespace
      const jsdbgMatch = command.match(/^jsdbg\s+(.+)$/);
      if (jsdbgMatch) {
        // Extract the actual command to debug
        const actualCommand = jsdbgMatch[1].trim();
        
        if (!actualCommand) {
          vscode.window.showErrorMessage('Usage: jsdbg <command>\n\nExample: jsdbg node myScript.js');
          return;
        }

        try {
          // Get the current working directory from the terminal
          const cwd = await getTerminalCwd(event.terminal);

          // Create a JavaScript Debug Terminal with the command
          await vscode.commands.executeCommand(
            Commands.CreateDebuggerTerminal,
            actualCommand,
            cwd ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd)) : undefined,
            cwd ? { cwd } : undefined
          );
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to create debug terminal: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      } else if (command === 'jsdbg') {
        // Handle the case where jsdbg is run without arguments
        vscode.window.showInformationMessage(
          'Usage: jsdbg <command>\n\nExample: jsdbg node myScript.js',
          'Learn More'
        ).then(selection => {
          if (selection === 'Learn More') {
            vscode.env.openExternal(vscode.Uri.parse(
              'https://code.visualstudio.com/docs/nodejs/nodejs-debugging'
            ));
          }
        });
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
