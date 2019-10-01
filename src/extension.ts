// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import { CancellationToken, DebugConfiguration, ProviderResult, WorkspaceFolder } from 'vscode';
import * as nls from 'vscode-nls';
import { SessionManager } from './ui/sessionManager';
import { registerCustomBreakpointsUI } from './ui/customBreakpointsUI';
import { registerDebugScriptActions } from './ui/debugScriptUI';
import { registerPrettyPrintActions } from './ui/prettyPrintUI';
import { DebugSessionTracker } from './ui/debugSessionTracker';

const localize = nls.config(JSON.parse(process.env.VSCODE_NLS_CONFIG || '{}'))();

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('pwa', new DebugConfigurationProvider()));
  new SessionManager(context);
  const debugSessionTracker = new DebugSessionTracker();
  registerCustomBreakpointsUI(context, debugSessionTracker);
  registerPrettyPrintActions(context, debugSessionTracker);
  registerDebugScriptActions(context);
}

export function deactivate() {
  // nothing to do
}

class DebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {
    if (folder && (folder.uri.scheme === 'file:' || folder.uri.scheme === 'file'))
      config.rootPath = folder.uri.fsPath;
    if (!config.type && !config.request && !config.name) {
      config.type = 'pwa';
      config.name = localize('debugConfig.launch.name', 'Launch browser with PWA');
      config.request = 'launch';
    }
    return config;
  }
}
