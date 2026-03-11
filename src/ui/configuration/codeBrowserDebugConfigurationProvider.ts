/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable } from 'inversify';
import * as vscode from 'vscode';
import { DebugType } from '../../common/contributionUtils';
import {
  AnyCodeBrowserConfiguration,
  codeBrowserAttachConfigDefaults,
  codeBrowserLaunchConfigDefaults,
  ResolvingCodeBrowserConfiguration,
} from '../../configuration';
import { BaseConfigurationResolver } from './baseConfigurationResolver';

/**
 * Configuration provider for VS Code integrated browser debugging.
 * Only available on desktop.
 */
@injectable()
export class CodeBrowserDebugConfigurationResolver
  extends BaseConfigurationResolver<AnyCodeBrowserConfiguration>
  implements vscode.DebugConfigurationProvider
{
  protected async resolveDebugConfigurationAsync(
    _folder: vscode.WorkspaceFolder | undefined,
    config: ResolvingCodeBrowserConfiguration,
  ): Promise<AnyCodeBrowserConfiguration | null | undefined> {
    if (vscode.env.uiKind === vscode.UIKind.Web) {
      vscode.window.showErrorMessage(
        'Integrated Browser debugging is only available on VS Code Desktop.',
      );
      return null;
    }

    if (!config.name && !config.type && !config.request) {
      return null;
    }

    return config.request === 'attach'
      ? { ...codeBrowserAttachConfigDefaults, ...config }
      : { ...codeBrowserLaunchConfigDefaults, ...config };
  }

  protected getType() {
    return DebugType.CodeBrowser as const;
  }

  protected getSuggestedWorkspaceFolders(config: AnyCodeBrowserConfiguration) {
    return [config.rootPath, config.webRoot];
  }
}
