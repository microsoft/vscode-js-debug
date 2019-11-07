// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import {
  extensionHostConfigDefaults,
  IExtensionHostConfiguration,
  ResolvingExtensionHostConfiguration,
} from './configuration';
import { BaseConfigurationProvider } from './baseConfigurationProvider';

/**
 * Configuration provider for Extension host debugging.
 */
export class ExtensionHostConfigurationProvider
  extends BaseConfigurationProvider<ResolvingExtensionHostConfiguration>
  implements vscode.DebugConfigurationProvider {

  protected async resolveDebugConfigurationAsync(
    _folder: vscode.WorkspaceFolder | undefined,
    config: ResolvingExtensionHostConfiguration,
  ): Promise<IExtensionHostConfiguration | undefined> {
    return Promise.resolve({
      ...extensionHostConfigDefaults,
      ...config,
    });
  }
}
