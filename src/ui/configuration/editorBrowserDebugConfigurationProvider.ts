/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { injectable } from 'inversify';
import { basename } from 'path';
import * as vscode from 'vscode';
import { DebugType } from '../../common/contributionUtils';
import {
  AnyEditorBrowserConfiguration,
  editorBrowserAttachConfigDefaults,
  editorBrowserLaunchConfigDefaults,
  IEditorBrowserLaunchConfiguration,
  ResolvingConfiguration,
  ResolvingEditorBrowserConfiguration,
} from '../../configuration';
import { BaseConfigurationProvider } from './baseConfigurationProvider';
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

@injectable()
export class EditorBrowserDebugConfigurationProvider
  extends BaseConfigurationProvider<IEditorBrowserLaunchConfiguration>
{
  protected getType() {
    return DebugType.EditorBrowser as const;
  }

  protected getTriggerKind() {
    return vscode.DebugConfigurationProviderTriggerKind.Initial;
  }

  protected provide(): ResolvingConfiguration<IEditorBrowserLaunchConfiguration> {
    return this.createLaunchConfigFromContext() || this.getDefaultLaunch();
  }

  public createLaunchConfigFromContext():
    | ResolvingConfiguration<IEditorBrowserLaunchConfiguration>
    | undefined
  {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'html') {
      return {
        type: this.getType(),
        request: 'launch',
        name: `Open ${basename(editor.document.uri.fsPath)}`,
        url: editor.document.uri.toString(),
      } as ResolvingConfiguration<IEditorBrowserLaunchConfiguration>;
    }

    return undefined;
  }

  private getDefaultLaunch(): ResolvingConfiguration<IEditorBrowserLaunchConfiguration> {
    return {
      type: this.getType(),
      request: 'launch',
      name: l10n.t('Launch Integrated Browser against localhost'),
      url: 'http://localhost:8080',
      webRoot: '${workspaceFolder}',
    } as ResolvingConfiguration<IEditorBrowserLaunchConfiguration>;
  }
}
