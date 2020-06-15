/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import {
  INodeLaunchConfiguration,
  AnyChromiumConfiguration,
  ResolvingConfiguration,
  IChromiumLaunchConfiguration,
  AnyChromiumLaunchConfiguration,
} from '../../configuration';
import { NodeConfigurationResolver } from './nodeDebugConfigurationResolver';
import { DebugType } from '../../common/contributionUtils';
import { BaseConfigurationResolver } from './baseConfigurationResolver';
import { TerminalDebugConfigurationResolver } from './terminalDebugConfigurationResolver';
import { injectable, inject } from 'inversify';
import { ExtensionContext, ExtensionLocation } from '../../ioc-extras';
import { basename } from 'path';
import * as nls from 'vscode-nls';
import { BaseConfigurationProvider } from './baseConfigurationProvider';

const localize = nls.loadMessageBundle();

const isLaunch = (
  value: ResolvingConfiguration<unknown>,
): value is ResolvingConfiguration<IChromiumLaunchConfiguration> => value.request === 'launch';

/**
 * Configuration provider for Chrome debugging.
 */
@injectable()
export abstract class ChromiumDebugConfigurationResolver<T extends AnyChromiumConfiguration>
  extends BaseConfigurationResolver<T>
  implements vscode.DebugConfigurationProvider {
  constructor(
    @inject(ExtensionContext) context: vscode.ExtensionContext,
    @inject(NodeConfigurationResolver)
    private readonly nodeProvider: NodeConfigurationResolver,
    @inject(TerminalDebugConfigurationResolver)
    private readonly terminalProvider: TerminalDebugConfigurationResolver,
    @inject(ExtensionLocation) private readonly location: ExtensionLocation,
  ) {
    super(context);
  }

  protected async resolveBrowserCommon(
    folder: vscode.WorkspaceFolder | undefined,
    config: ResolvingConfiguration<T>,
  ) {
    if (config.request === 'attach') {
      // todo https://github.com/microsoft/vscode-chrome-debug/blob/ee5ae7ac7734f369dba58ba57bb910aac467c97a/src/extension.ts#L48
    }

    if (config.server && 'program' in config.server) {
      const serverOpts = {
        ...config.server,
        type: DebugType.Node,
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
        type: DebugType.Terminal,
        request: 'launch',
        name: `${config.name}: Server`,
      });
    }

    if (isLaunch(config) && !config.browserLaunchLocation) {
      config.browserLaunchLocation = this.location === 'remote' ? 'ui' : 'workspace';
    }
  }

  /**
   * @override
   */
  protected getSuggestedWorkspaceFolders(config: AnyChromiumConfiguration) {
    return [config.rootPath, config.webRoot];
  }
}

@injectable()
export abstract class ChromiumDebugConfigurationProvider<
  T extends AnyChromiumLaunchConfiguration
> extends BaseConfigurationProvider<T> {
  protected provide() {
    return this.createLaunchConfigFromContext() || this.getDefaultLaunch();
  }

  protected getTriggerKind() {
    return vscode.DebugConfigurationProviderTriggerKind.Initial;
  }

  public createLaunchConfigFromContext() {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'html') {
      return {
        type: this.getType(),
        request: 'launch',
        name: `Open ${basename(editor.document.uri.fsPath)}`,
        file: editor.document.uri.fsPath,
      } as ResolvingConfiguration<T>;
    }

    return undefined;
  }

  protected getDefaultLaunch() {
    return {
      type: this.getType(),
      request: 'launch',
      name: localize('chrome.launch.name', 'Launch Chrome against localhost'),
      url: 'http://localhost:8080',
      webRoot: '${workspaceFolder}',
    } as ResolvingConfiguration<T>;
  }
}
