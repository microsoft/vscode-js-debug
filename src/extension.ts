// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as nls from 'vscode-nls';
import * as vscode from 'vscode';
import {WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken} from 'vscode';
import {registerCustomBreakpointsUI} from './ui/customBreakpointsUI';
import {registerExecutionContextsUI} from './ui/executionContextsUI';
import {AdapterFactory} from './adapterFactory';
import * as queryString from 'querystring';
import Dap from './dap/api';

const localize = nls.config(JSON.parse(process.env.VSCODE_NLS_CONFIG || '{}'))();

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('cdp', new DebugConfigurationProvider()));
  const factory = new AdapterFactory(context);
  registerCustomBreakpointsUI(factory);
  registerExecutionContextsUI(factory);

  context.subscriptions.push(vscode.commands.registerCommand('cdp.prettyPrint', async e => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !factory.activeAdapter())
      return;
    const uri = editor.document.uri;
    if (uri.scheme !== 'debug')
      return;
    const query = queryString.parse(uri.query);
    const dapSource: Dap.Source = { path: uri.path, sourceReference: +(query['ref'] as string)};
    const sessionId = query['session'] as string;
    const adapter = factory.adapter(sessionId || '');
    if (!adapter)
      return;
    const source = await adapter.sourceContainer.prettyPrintSource(dapSource);
    if (!source)
      return;
    const prettyUri = vscode.Uri.parse(`debug:${uri.path}?session=${sessionId}&ref=${source.sourceReference()}`);
    const document = await vscode.workspace.openTextDocument(prettyUri);
    vscode.window.showTextDocument(document);
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
