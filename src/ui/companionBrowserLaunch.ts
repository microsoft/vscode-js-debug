/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import Dap from '../dap/api';

const launchCompanionBrowser = async (args: Dap.LaunchBrowserInCompanionEventParams) => {
  try {
    const uri = await vscode.env.asExternalUri(
      vscode.Uri.parse(`http://127.0.0.1:${args.serverPort}`),
    );

    await vscode.commands.executeCommand('js-debug-companion.launchAndAttach', {
      proxyUri: uri.authority,
      ...args,
    });
  } catch (e) {
    vscode.window.showErrorMessage(`Error launching browser: ${e.message || e.stack}`);
  }
};

const killCompanionBrowser = ({ launchId }: Dap.KillCompanionBrowserEventParams) =>
  vscode.commands.executeCommand('js-debug-companion.kill', { launchId });

export function registerCompanionBrowserLaunch(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.debug.onDidReceiveDebugSessionCustomEvent(async event => {
      switch (event.event) {
        case 'launchBrowserInCompanion':
          return launchCompanionBrowser(event.body);
        case 'killCompanionBrowser':
          return killCompanionBrowser(event.body);
        default:
        // ignored
      }
    }),
  );
}
