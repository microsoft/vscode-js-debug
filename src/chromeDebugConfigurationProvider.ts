// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import {
  ResolvingChromeConfiguration,
  AnyChromeConfiguration,
  INodeLaunchConfiguration,
  chromeAttachConfigDefaults,
  chromeLaunchConfigDefaults,
} from './configuration';
import { NodeDebugConfigurationProvider } from './nodeDebugConfigurationProvider';
import { Contributions } from './common/contributionUtils';

/**
 * Configuration provider for Chrome debugging.
 */
export class ChromeDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  constructor(private readonly nodeProvider: NodeDebugConfigurationProvider) {}

  public resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    token?: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    return this.resolveDebugConfigurationAsync(
      folder,
      config as ResolvingChromeConfiguration,
    ).catch(err => {
      return vscode.window.showErrorMessage(err.message, { modal: true }).then(_ => undefined); // abort launch
    });
  }

  private async resolveDebugConfigurationAsync(
    folder: vscode.WorkspaceFolder | undefined,
    config: ResolvingChromeConfiguration,
  ): Promise<AnyChromeConfiguration | undefined> {
    if (!config.name && !config.type && !config.request) {
      // Return null so it will create a launch.json and fall back on provideDebugConfigurations - better to point the user towards the config
      // than try to work automagically.
      return;
    }

    if (config.request === 'attach') {
      // todo https://github.com/microsoft/vscode-chrome-debug/blob/ee5ae7ac7734f369dba58ba57bb910aac467c97a/src/extension.ts#L48
    } else if (config.server) {
      const serverOpts = {
        ...config.server,
        type: Contributions.NodeDebugType,
        request: 'launch',
        name: `${config.name}: Server`,
      };

      config.server = (await this.nodeProvider.resolveDebugConfiguration(
        folder,
        serverOpts,
      )) as INodeLaunchConfiguration;
    }

    return config.request === 'attach'
      ? { ...chromeAttachConfigDefaults, ...config }
      : { ...chromeLaunchConfigDefaults, ...config };
  }
}
