/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import Dap from '../dap/api';

export function registerCompanionBrowserLaunch(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.debug.onDidReceiveDebugSessionCustomEvent(async event => {
      if (event.event !== 'launchBrowserInCompanion') {
        return;
      }

      const args: Dap.LaunchBrowserInCompanionParams = event.body;
      try {
        const uri = await vscode.env.asExternalUri(
          vscode.Uri.parse(`http://127.0.0.1:${args.serverPort}`),
        );

        await vscode.commands.executeCommand('js-debug-companion.launchAndAttach', {
          uri: uri.toString().replace('http:', ''),
          ...args,
        });
      } catch (e) {
        vscode.window.showErrorMessage(`Error launching browser: ${e.message || e.stack}`);
      }
    }),
  );
}
