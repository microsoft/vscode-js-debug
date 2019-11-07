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
import { BaseConfigurationProvider } from './baseConfigurationProvider';

/**
 * Configuration provider for Chrome debugging.
 */
export class ChromeDebugConfigurationProvider
  extends BaseConfigurationProvider<AnyChromeConfiguration>
  implements vscode.DebugConfigurationProvider {
  constructor(
    context: vscode.ExtensionContext,
    private readonly nodeProvider: NodeDebugConfigurationProvider,
  ) {
    super(context);
  }

  protected async resolveDebugConfigurationAsync(
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
