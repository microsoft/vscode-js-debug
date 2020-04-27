/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import {
  edgeAttachConfigDefaults,
  edgeLaunchConfigDefaults,
  ResolvingEdgeConfiguration,
  AnyEdgeConfiguration,
  IEdgeLaunchConfiguration,
} from '../../configuration';
import { DebugType } from '../../common/contributionUtils';
import {
  ChromiumDebugConfigurationResolver,
  ChromiumDebugConfigurationProvider,
} from './chromiumDebugConfigurationProvider';
import { injectable } from 'inversify';

/**
 * Configuration provider for Chrome debugging.
 */
@injectable()
export class EdgeDebugConfigurationResolver
  extends ChromiumDebugConfigurationResolver<AnyEdgeConfiguration>
  implements vscode.DebugConfigurationProvider {
  /**
   * @override
   */
  protected async resolveDebugConfigurationAsync(
    folder: vscode.WorkspaceFolder | undefined,
    config: ResolvingEdgeConfiguration,
  ): Promise<AnyEdgeConfiguration | undefined> {
    if (!config.name && !config.type && !config.request) {
      const fromContext = new EdgeDebugConfigurationProvider().createLaunchConfigFromContext();
      if (!fromContext) {
        // Return null so it will create a launch.json and fall back on
        // provideDebugConfigurations - better to point the user towards
        // the config than try to work automagically for complex scenarios.
        return;
      }

      config = fromContext;
    }

    await this.resolveBrowserCommon(folder, config);

    // Disable attachment timeouts for webview apps. We aren't opening a
    // browser immediately, and it may take an arbitrary amount of time within
    // the app until a debuggable webview appears.
    if (config.useWebView) {
      config.timeout = config.timeout ?? 0;
    }

    return config.request === 'attach'
      ? { ...edgeAttachConfigDefaults, ...config }
      : { ...edgeLaunchConfigDefaults, ...config };
  }

  protected getType() {
    return DebugType.Edge as const;
  }
}

@injectable()
export class EdgeDebugConfigurationProvider extends ChromiumDebugConfigurationProvider<
  IEdgeLaunchConfiguration
> {
  protected getType() {
    return DebugType.Edge as const;
  }
}
