/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import {
  edgeAttachConfigDefaults,
  edgeLaunchConfigDefaults,
  ResolvingEdgeConfiguration,
  AnyEdgeConfiguration,
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
export class EdgeDebugConfigurationProvider
  extends ChromiumDebugConfigurationProvider<AnyEdgeConfiguration>
  implements vscode.DebugConfigurationProvider {
  /**
   * @override
   */
  protected async resolveDebugConfigurationAsync(
    folder: vscode.WorkspaceFolder | undefined,
    config: ResolvingEdgeConfiguration,
  ): Promise<AnyEdgeConfiguration | undefined> {
    if (!config.name && !config.type && !config.request) {
      const fromContext = this.createLaunchConfigFromContext();
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

  protected createLaunchConfigFromContext(): ResolvingEdgeConfiguration | void {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'html') {
      return {
        type: DebugType.Edge,
        request: 'launch',
        name: `Open ${basename(editor.document.uri.fsPath)}`,
        file: editor.document.uri.fsPath,
      };
    }

    return undefined;
  }

  protected getDefaultAttachment(): ResolvingEdgeConfiguration {
    return {
      type: DebugType.Edge,
      request: 'launch',
      name: localize('edge.launch.name', 'Launch Chrome against localhost'),
      url: 'http://localhost:8080',
      webRoot: '${workspaceFolder}',
    };
  }

  protected getType() {
    return DebugType.Edge as const;
  }
}
