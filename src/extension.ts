// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import { CancellationToken, DebugConfiguration, ProviderResult, WorkspaceFolder } from 'vscode';
import * as nls from 'vscode-nls';
import { AdapterFactory } from './adapterFactory';
import { registerCustomBreakpointsUI } from './ui/customBreakpointsUI';
import { LocationRevealerUI } from './ui/locationRevealerUI';
import { registerDebugScriptActions } from './ui/debugScriptUI';
import { registerPrettyPrintActions } from './ui/prettyPrintUI';

const localize = nls.config(JSON.parse(process.env.VSCODE_NLS_CONFIG || '{}'))();

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('pwa', new DebugConfigurationProvider()));
  const factory = new AdapterFactory(context);
  new LocationRevealerUI(context, factory);
  registerCustomBreakpointsUI(context, factory);
  registerPrettyPrintActions(context, factory);
  registerDebugScriptActions(context, factory);
}

export function deactivate() {
  // nothing to do
}

class DebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {
    if (!config.type && !config.request && !config.name) {
      config.type = 'pwa';
      config.name = localize('debugConfig.launch.name', 'Launch browser with PWA');
      config.request = 'launch';
    }
    return config;
  }
}
