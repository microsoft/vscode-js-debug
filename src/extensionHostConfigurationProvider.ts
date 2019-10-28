// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import {
  extensionHostConfigDefaults,
  IExtensionHostConfiguration,
  ResolvingExtensionHostConfiguration,
} from './configuration';

/**
 * Configuration provider for Extension host debugging.
 */
export class ExtensionHostConfigurationProvider implements vscode.DebugConfigurationProvider {
  constructor() {}

  public resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    return this.resolveDebugConfigurationAsync(
      folder,
      config as ResolvingExtensionHostConfiguration,
    ).catch(err => {
      return vscode.window.showErrorMessage(err.message, { modal: true }).then(_ => undefined); // abort launch
    });
  }

  private resolveDebugConfigurationAsync(
    _folder: vscode.WorkspaceFolder | undefined,
    config: ResolvingExtensionHostConfiguration,
  ): Promise<IExtensionHostConfiguration | undefined> {
    return Promise.resolve({
      ...extensionHostConfigDefaults,
      ...config,
    });
  }
}
