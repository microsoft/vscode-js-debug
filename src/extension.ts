// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from 'vscode';
import * as Net from 'net';
import DapConnection from './dap/connection';
import {Adapter} from './adapter/adapter';
import {registerCustomBreakpointsUI} from './ui/customBreakpointsUI';

export function activate(context: vscode.ExtensionContext) {
  const provider = new MockConfigurationProvider();
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('cdp', provider));

  const factory = new MockDebugAdapterDescriptorFactory();
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('cdp', factory));
  context.subscriptions.push(factory);

  registerCustomBreakpointsUI(context.workspaceState);
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

  createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    if (!this.server) {
      // start listening on a random port
      this.server = Net.createServer(socket => {
        const connection = new DapConnection(socket, socket);
        new Adapter(connection.dap());
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
