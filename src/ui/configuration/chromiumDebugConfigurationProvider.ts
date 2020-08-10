/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import { DebugType } from '../../common/contributionUtils';
import { existsInjected } from '../../common/fsUtils';
import {
  AnyChromiumConfiguration,
  AnyChromiumLaunchConfiguration,
  IChromiumLaunchConfiguration,
  INodeLaunchConfiguration,
  ResolvingConfiguration,
} from '../../configuration';
import { ExtensionContext, ExtensionLocation, FS, FsPromises } from '../../ioc-extras';
import { BaseConfigurationProvider } from './baseConfigurationProvider';
import { BaseConfigurationResolver } from './baseConfigurationResolver';
import { NodeConfigurationResolver } from './nodeDebugConfigurationResolver';
import { TerminalDebugConfigurationResolver } from './terminalDebugConfigurationResolver';

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
    @inject(FS) private readonly fs: FsPromises,
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

  /**
   * @inheritdoc
   */
  public async resolveDebugConfigurationWithSubstitutedVariables?(
    _folder: vscode.WorkspaceFolder | undefined,
    debugConfiguration: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | undefined> {
    if ('__pendingTargetId' in debugConfiguration) {
      return debugConfiguration as T;
    }

    let config = debugConfiguration as T;

    if (config.request === 'launch') {
      const resolvedDataDir = await this.ensureNoLockfile(config);
      if (resolvedDataDir === undefined) {
        return;
      }

      config = resolvedDataDir;
    }

    return config;
  }

  protected async ensureNoLockfile(config: T): Promise<T | undefined> {
    if (config.request !== 'launch') {
      return config;
    }

    const cast = config as ResolvingConfiguration<AnyChromiumLaunchConfiguration>;

    // for no user data dirs, with have nothing to look at
    if (cast.userDataDir === false) {
      return config;
    }

    // if there's a port configured and something's there, we can connect to it regardless
    if (cast.port) {
      return config;
    }

    const userDataDir =
      typeof cast.userDataDir === 'string'
        ? cast.userDataDir
        : join(
            this.extensionContext.storagePath ?? tmpdir(),
            cast.runtimeArgs?.includes('--headless') ? '.headless-profile' : '.profile',
          );

    if (await existsInjected(this.fs, join(userDataDir, 'lockfile'))) {
      const debugAnyway = localize('existingBrowser.debugAnyway', 'Debug Anyway');
      const result = await vscode.window.showErrorMessage(
        localize(
          'existingBrowser.alert',
          'It looks like a browser is already running from {0}. Please close it before trying to debug, otherwise VS Code may not be able to connect to it.',
          cast.userDataDir === true
            ? localize('existingBrowser.location.default', 'an old debug session')
            : localize('existingBrowser.location.userDataDir', 'the configured userDataDir'),
        ),
        debugAnyway,
        localize('cancel', 'Cancel'),
      );

      if (result !== debugAnyway) {
        return undefined;
      }
    }

    return { ...config, userDataDir };
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
