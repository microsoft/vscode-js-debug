/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import Dap from '../dap/api';
import { readConfig, Configuration } from '../common/contributionUtils';
import { URL } from 'url';

const localize = nls.loadMessageBundle();
const sessionTunnels = new Map<string, vscode.Tunnel>();

const isTunnelForPort = (port: number) => (tunnel: vscode.TunnelDescription) =>
  typeof tunnel.localAddress === 'string'
    ? tunnel.localAddress.endsWith(`:${port}`)
    : tunnel.localAddress.port === port;

const tunnelRemoteServerIfNecessary = async (args: Dap.LaunchBrowserInCompanionEventParams) => {
  const urlStr = (args.params as { url?: string }).url;
  if (!urlStr) {
    return;
  }

  let url: URL;
  try {
    url = new URL(urlStr);
  } catch (e) {
    return;
  }

  if (!readConfig(vscode.workspace, Configuration.AutoServerTunnelOpen)) {
    return;
  }

  const port = Number(url.port) || 80;
  if ((await vscode.workspace.tunnels).some(isTunnelForPort(port))) {
    return;
  }

  try {
    await vscode.workspace.openTunnel({
      remoteAddress: { port, host: 'localhost' },
      localAddressPort: port,
    });
  } catch {
    // throws if already forwarded by user or by us previously
  }
};

const launchCompanionBrowser = async (
  session: vscode.DebugSession,
  args: Dap.LaunchBrowserInCompanionEventParams,
) => {
  if (vscode.env.uiKind === vscode.UIKind.Web) {
    return vscode.window.showErrorMessage(
      localize(
        'cannotDebugInBrowser',
        "We can't launch a browser in debug mode from here. Open this workspace in VS Code on your desktop to enable debugging.",
      ),
    );
  }

  try {
    const [, tunnel] = await Promise.all([
      tunnelRemoteServerIfNecessary(args),
      Promise.resolve(
        vscode.workspace.openTunnel({
          remoteAddress: { port: args.serverPort, host: 'localhost' },
          localAddressPort: args.serverPort,
          label: 'Browser Debug Tunnel',
        }),
      ).catch(() => undefined),
    ]);

    if (tunnel) {
      sessionTunnels.set(session.id, tunnel);
    }

    await vscode.commands.executeCommand('js-debug-companion.launchAndAttach', {
      proxyUri: tunnel
        ? `${tunnel.remoteAddress.host}:${tunnel.remoteAddress.port}`
        : `127.0.0.1:${args.serverPort}`,
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
