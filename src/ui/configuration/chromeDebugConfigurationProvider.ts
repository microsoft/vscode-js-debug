/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable } from 'inversify';
import * as vscode from 'vscode';
import { DebugType } from '../../common/contributionUtils';
import {
  AnyChromeConfiguration,
  chromeAttachConfigDefaults,
  chromeLaunchConfigDefaults,
  IChromeLaunchConfiguration,
  ResolvingChromeConfiguration,
} from '../../configuration';
import {
  ChromiumDebugConfigurationProvider,
  ChromiumDebugConfigurationResolver,
} from './chromiumDebugConfigurationProvider';

/**
 * Configuration provider for Chrome debugging.
 */
@injectable()
export class ChromeDebugConfigurationResolver
  extends ChromiumDebugConfigurationResolver<AnyChromeConfiguration>
  implements vscode.DebugConfigurationProvider
{
  /**
   * @override
   */
  protected async resolveDebugConfigurationAsync(
    folder: vscode.WorkspaceFolder | undefined,
    config: ResolvingChromeConfiguration,
  ): Promise<AnyChromeConfiguration | null | undefined> {
    if (!config.name && !config.type && !config.request) {
      const fromContext = new ChromeDebugConfigurationProvider().createLaunchConfigFromContext();
      if (!fromContext) {
        // Return null so it will create a launch.json and fall back on
        // provideDebugConfigurations - better to point the user towards
        // the config than try to work automagically for complex scenarios.
        return null;
      }

      config = fromContext;
    }

    await this.resolveBrowserCommon(folder, config);

    return config.request === 'attach'
      ? { ...chromeAttachConfigDefaults, ...config }
      : { ...chromeLaunchConfigDefaults, ...config };
  }

  protected getType() {
    return DebugType.Chrome as const;
  }
}

@injectable()
export class ChromeDebugConfigurationProvider
  extends ChromiumDebugConfigurationProvider<IChromeLaunchConfiguration>
{
  protected getType() {
    return DebugType.Chrome as const;
  }
}
