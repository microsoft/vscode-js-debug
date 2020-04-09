/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import {
  INodeLaunchConfiguration,
  AnyChromiumConfiguration,
  ResolvingConfiguration,
  IChromiumLaunchConfiguration,
} from '../../configuration';
import { NodeConfigurationProvider } from './nodeDebugConfigurationProvider';
import { DebugType } from '../../common/contributionUtils';
import { BaseConfigurationProvider } from './baseConfigurationProvider';
import { TerminalDebugConfigurationProvider } from './terminalDebugConfigurationProvider';
import { injectable, inject } from 'inversify';
import { ExtensionContext, ExtensionLocation } from '../../ioc-extras';

const isLaunch = (
  value: ResolvingConfiguration<unknown>,
): value is ResolvingConfiguration<IChromiumLaunchConfiguration> => value.request === 'launch';

/**
 * Configuration provider for Chrome debugging.
 */
@injectable()
export abstract class ChromiumDebugConfigurationProvider<T extends AnyChromiumConfiguration>
  extends BaseConfigurationProvider<T>
  implements vscode.DebugConfigurationProvider {
  constructor(
    @inject(ExtensionContext) context: vscode.ExtensionContext,
    @inject(NodeConfigurationProvider)
    private readonly nodeProvider: NodeConfigurationProvider,
    @inject(TerminalDebugConfigurationProvider)
    private readonly terminalProvider: TerminalDebugConfigurationProvider,
    @inject(ExtensionLocation) private readonly location: ExtensionLocation,
  ) {
    super(context);

    this.setProvideDefaultConfiguration(
      () => this.createLaunchConfigFromContext() || this.getDefaultAttachment(),
    );
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

  protected abstract getDefaultAttachment(): ResolvingConfiguration<T>;

  protected abstract createLaunchConfigFromContext(): ResolvingConfiguration<T> | void;
}
