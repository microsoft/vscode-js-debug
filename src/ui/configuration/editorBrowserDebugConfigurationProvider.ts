/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable } from 'inversify';
import * as vscode from 'vscode';
import { DebugType } from '../../common/contributionUtils';
import {
  AnyEditorBrowserConfiguration,
  editorBrowserAttachConfigDefaults,
  editorBrowserLaunchConfigDefaults,
  ResolvingEditorBrowserConfiguration,
} from '../../configuration';
import { BaseConfigurationResolver } from './baseConfigurationResolver';

/**
 * Configuration provider for VS Code integrated browser debugging.
 * Only available on desktop.
 */
@injectable()
export class EditorBrowserDebugConfigurationResolver
  extends BaseConfigurationResolver<AnyEditorBrowserConfiguration>
  implements vscode.DebugConfigurationProvider
{
  protected async resolveDebugConfigurationAsync(
    _folder: vscode.WorkspaceFolder | undefined,
    config: ResolvingEditorBrowserConfiguration,
  ): Promise<AnyEditorBrowserConfiguration | null | undefined> {
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
      ? { ...editorBrowserAttachConfigDefaults, ...config }
      : { ...editorBrowserLaunchConfigDefaults, ...config };
  }

  protected getType() {
    return DebugType.EditorBrowser as const;
  }

  protected getSuggestedWorkspaceFolders(config: AnyEditorBrowserConfiguration) {
    return [config.rootPath, config.webRoot];
  }
}
