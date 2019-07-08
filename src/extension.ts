/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as nls from 'vscode-nls';
import * as vscode from 'vscode';
import {WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken} from 'vscode';
import {registerCustomBreakpointsUI} from './ui/customBreakpointsUI';
import {registerExecutionContextsUI} from './ui/executionContextsUI';
import * as querystring from 'querystring';
import Dap from './dap/api';
import {AdapterFactory} from './adapterFactory';

const localize = nls.config(JSON.parse(process.env.VSCODE_NLS_CONFIG || '{}'))();

export function activate(context: vscode.ExtensionContext) {
  const factory = new AdapterFactory(context);

  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('cdp', new DebugConfigurationProvider()));

  registerCustomBreakpointsUI(factory);
  registerExecutionContextsUI(context);

  context.subscriptions.push(vscode.commands.registerCommand('cdp.toggleActiveDocumentBlackboxed', e => {
    const session = vscode.debug.activeDebugSession;
    if (!session || session.type !== 'cdp')
      return;
    if (!vscode.window.activeTextEditor)
      return;
    const uri = vscode.window.activeTextEditor.document.uri;
    if (uri.scheme === 'file') {
      const params: Dap.ToggleSourceBlackboxedParams = {source: {path: uri.path}};
      session.customRequest('toggleSourceBlackboxed', params);
    } else if (uri.scheme === 'debug') {
      const ref = querystring.parse(uri.query).ref;
      const refNumber = parseInt(typeof ref === 'string' ? ref : '');
      if (refNumber && String(refNumber) === ref) {
        const params: Dap.ToggleSourceBlackboxedParams = {source: {sourceReference: refNumber}};
        session.customRequest('toggleSourceBlackboxed', params);
      }
    }
  }));
}

export function deactivate() {
  // nothing to do
}

class DebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {
    if (!config.type && !config.request && !config.name) {
      config.type = 'cdp';
      config.name = localize('debugConfig.launch.name', 'Run in Chrome with CDP');
      config.request = 'launch';
    }
    if (!config.url)
      config.url = 'http://localhost:8000';
    if (folder && !config.webRoot)
      config.webRoot = folder.uri.fsPath;
    return config;
  }
}
