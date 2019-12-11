/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
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
import { basename } from 'path';
import { TerminalDebugConfigurationProvider } from './terminalDebugConfigurationProvider';

const localize = nls.loadMessageBundle();

/**
 * Configuration provider for Chrome debugging.
 */
export class ChromeDebugConfigurationProvider
  extends BaseConfigurationProvider<AnyChromeConfiguration>
  implements vscode.DebugConfigurationProvider {
  constructor(
    context: vscode.ExtensionContext,
    private readonly nodeProvider: NodeDebugConfigurationProvider,
    private readonly terminalProvider: TerminalDebugConfigurationProvider,
  ) {
    super(context);

    this.setProvideDefaultConfiguration(
      () =>
        createLaunchConfigFromContext() || {
          type: Contributions.ChromeDebugType,
          request: 'launch',
          name: localize('chrome.launch.name', 'Launch Chrome against localhost'),
          url: 'http://localhost:8080',
          webRoot: '${workspaceFolder}',
        },
    );
  }

  /**
   * @override
   */
  protected async resolveDebugConfigurationAsync(
    folder: vscode.WorkspaceFolder | undefined,
    config: ResolvingChromeConfiguration,
  ): Promise<AnyChromeConfiguration | undefined> {
    if (!config.name && !config.type && !config.request) {
      const fromContext = createLaunchConfigFromContext();
      if (!fromContext) {
        // Return null so it will create a launch.json and fall back on
        // provideDebugConfigurations - better to point the user towards
        // the config than try to work automagically for complex scenarios.
        return;
      }

      config = fromContext;
    }

    if (config.request === 'attach') {
      // todo https://github.com/microsoft/vscode-chrome-debug/blob/ee5ae7ac7734f369dba58ba57bb910aac467c97a/src/extension.ts#L48
    }

    if (config.server && 'program' in config.server) {
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
    } else if (config.server && 'command' in config.server) {
      config.server = await this.terminalProvider.resolveDebugConfiguration(folder, {
        ...config.server,
        type: Contributions.TerminalDebugType,
        request: 'launch',
        name: `${config.name}: Server`,
      });
    }

    return config.request === 'attach'
      ? { ...chromeAttachConfigDefaults, ...config }
      : { ...chromeLaunchConfigDefaults, ...config };
  }
}

function createLaunchConfigFromContext(): ResolvingChromeConfiguration | void {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.languageId === 'html') {
    return {
      type: Contributions.ChromeDebugType,
      request: 'launch',
      name: `Open ${basename(editor.document.uri.fsPath)}`,
      file: editor.document.uri.fsPath,
    };
  }

  return undefined;
}
