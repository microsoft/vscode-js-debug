// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as nls from 'vscode-nls';
import * as vscode from 'vscode';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from 'vscode';
import { registerCustomBreakpointsUI } from './ui/customBreakpointsUI';
import { registerExecutionContextsUI } from './ui/executionContextsUI';
import { registerPrettyPrintActions } from './ui/prettyPrintUI';
import { AdapterFactory } from './adapterFactory';
import { LocationRevealerUI } from './ui/locationRevealerUI';

const localize = nls.config(JSON.parse(process.env.VSCODE_NLS_CONFIG || '{}'))();

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('pwa', new DebugConfigurationProvider()));
  const factory = new AdapterFactory(context);
  new LocationRevealerUI(context, factory);
  registerCustomBreakpointsUI(factory);
  registerExecutionContextsUI(factory);
  registerPrettyPrintActions(context, factory);
}

export function deactivate() {
  // nothing to do
}

class DebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {
    if (!config.type && !config.request && !config.name) {
      config.type = 'pwa';
      config.name = localize('debugConfig.launch.name', 'Launhc Chrome with PWA');
      config.request = 'launch';
    }
    return config;
  }
}
