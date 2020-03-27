/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import {
  ResolvingChromeConfiguration,
  AnyChromeConfiguration,
  chromeAttachConfigDefaults,
  chromeLaunchConfigDefaults,
} from '../../configuration';
import { DebugType } from '../../common/contributionUtils';
import { basename } from 'path';
import { ChromiumDebugConfigurationProvider } from './chromiumDebugConfigurationProvider';
import { injectable } from 'inversify';

const localize = nls.loadMessageBundle();

/**
 * Configuration provider for Chrome debugging.
 */
@injectable()
export class ChromeDebugConfigurationProvider
  extends ChromiumDebugConfigurationProvider<AnyChromeConfiguration>
  implements vscode.DebugConfigurationProvider {
  /**
   * @override
   */
  protected async resolveDebugConfigurationAsync(
    folder: vscode.WorkspaceFolder | undefined,
    config: ResolvingChromeConfiguration,
  ): Promise<AnyChromeConfiguration | null | undefined> {
    if ('__pendingTargetId' in config) {
      return config as AnyChromeConfiguration;
    }

    if (!config.name && !config.type && !config.request) {
      const fromContext = this.createLaunchConfigFromContext();
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

  protected createLaunchConfigFromContext(): ResolvingChromeConfiguration | void {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'html') {
      return {
        type: DebugType.Chrome,
        request: 'launch',
        name: `Open ${basename(editor.document.uri.fsPath)}`,
        file: editor.document.uri.fsPath,
      };
    }

    return undefined;
  }

  protected getDefaultAttachment(): ResolvingChromeConfiguration {
    return {
      type: DebugType.Chrome,
      request: 'launch',
      name: localize('chrome.launch.name', 'Launch Chrome against localhost'),
      url: 'http://localhost:8080',
      webRoot: '${workspaceFolder}',
    };
  }

  protected getType() {
    return DebugType.Chrome as const;
  }
}
