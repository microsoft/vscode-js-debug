/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from 'vscode';
import * as Net from 'net';
import DapConnection from './dap/connection';
import {Adapter} from './adapter/adapter';
import {registerCustomBreakpointsUI} from './ui/customBreakpointsUI';
import {registerExecutionContextsUI} from './ui/executionContextsUI';
import * as querystring from 'querystring';
import Dap from './dap/api';

export function activate(context: vscode.ExtensionContext) {
  const provider = new MockConfigurationProvider();
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('cdp', provider));

  const factory = new MockDebugAdapterDescriptorFactory(context);
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('cdp', factory));
  context.subscriptions.push(factory);

  registerCustomBreakpointsUI(context);
  registerExecutionContextsUI(context);

  context.subscriptions.push(vscode.commands.registerCommand('cdp.blackboxActiveDocument', e => {
    const session = vscode.debug.activeDebugSession;
    if (!session || session.type !== 'cdp')
      return;
    if (!vscode.window.activeTextEditor)
      return;
    const uri = vscode.window.activeTextEditor.document.uri;
    if (uri.scheme === 'file') {
      const params: Dap.SetSourceBlackboxedParams = {source: {path: uri.path}, blackboxed: true};
      session.customRequest('setSourceBlackboxed', params);
    } else if (uri.scheme === 'debug') {
      const ref = querystring.parse(uri.query).ref;
      const refNumber = parseInt(typeof ref === 'string' ? ref : '');
      if (refNumber && String(refNumber) === ref) {
        const params: Dap.SetSourceBlackboxedParams = {source: {sourceReference: refNumber}, blackboxed: true};
        session.customRequest('setSourceBlackboxed', params);
      }
    }
  }));
}

export function deactivate() {
  // nothing to do
}

class MockConfigurationProvider implements vscode.DebugConfigurationProvider {
  /**
   * Massage a debug configuration just before a debug session is being launched,
   * e.g. add all missing attributes to the debug configuration.
   */
  resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {

    // if launch.json is missing or empty
    if (!config.type && !config.request && !config.name) {
      config.type = 'cdp';
      config.name = 'Launch';
      config.request = 'launch';
    }
    return config;
  }
}

class MockDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
  private server?: Net.Server;
  private _context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this._context = context;
  }

  createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    if (!this.server) {
      // start listening on a random port
      this.server = Net.createServer(socket => {
        const connection = new DapConnection(socket, socket);
        new Adapter(connection.dap(), this._context.storagePath || this._context.extensionPath);
      }).listen(0);
    }

    // make VS Code connect to debug server
    return new vscode.DebugAdapterServer(this.server.address().port);
  }

  dispose() {
    if (this.server) {
      this.server.close();
    }
  }
}
