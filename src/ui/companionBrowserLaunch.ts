/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import Dap from '../dap/api';

const sessionTunnels = new Map<string, vscode.Tunnel>();

const launchCompanionBrowser = async (
  session: vscode.DebugSession,
  args: Dap.LaunchBrowserInCompanionEventParams,
) => {
  try {
    const tunnel = await vscode.workspace.openTunnel({
      remoteAddress: { port: args.serverPort, host: 'localhost' },
      localAddressPort: args.serverPort,
      label: 'Browser Debug Tunnel',
    });

    sessionTunnels.set(session.id, tunnel);

    await vscode.commands.executeCommand('js-debug-companion.launchAndAttach', {
      proxyUri: tunnel
        ? `${tunnel.remoteAddress.host}:${tunnel.remoteAddress.port}`
        : `127.0.01:${args.serverPort}`,
      ...args,
    });
  } catch (e) {
    vscode.window.showErrorMessage(`Error launching browser: ${e.message || e.stack}`);
  }
};

const killCompanionBrowser = (
  session: vscode.DebugSession,
  { launchId }: Dap.KillCompanionBrowserEventParams,
) => {
  vscode.commands.executeCommand('js-debug-companion.kill', { launchId });
  disposeSessionTunnel(session);
};

const disposeSessionTunnel = (session: vscode.DebugSession) => {
  sessionTunnels.get(session.id)?.dispose();
  sessionTunnels.delete(session.id);
};

export function registerCompanionBrowserLaunch(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession(disposeSessionTunnel),
    vscode.debug.onDidReceiveDebugSessionCustomEvent(async event => {
      switch (event.event) {
        case 'launchBrowserInCompanion':
          return launchCompanionBrowser(event.session, event.body);
        case 'killCompanionBrowser':
          return killCompanionBrowser(event.session, event.body);
        default:
        // ignored
      }
    }),
  );
}
