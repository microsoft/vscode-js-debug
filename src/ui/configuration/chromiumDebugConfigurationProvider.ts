/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { inject, injectable } from 'inversify';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import * as vscode from 'vscode';
import { DebugType } from '../../common/contributionUtils';
import { isPortOpen } from '../../common/findOpenPort';
import { existsWithoutDeref } from '../../common/fsUtils';
import { some } from '../../common/promiseUtil';
import {
  AnyChromiumConfiguration,
  AnyChromiumLaunchConfiguration,
  IChromiumAttachConfiguration,
  IChromiumLaunchConfiguration,
  INodeLaunchConfiguration,
  ResolvingConfiguration,
} from '../../configuration';
import { ExtensionContext, ExtensionLocation, FS, FsPromises } from '../../ioc-extras';
import { BaseConfigurationProvider } from './baseConfigurationProvider';
import { BaseConfigurationResolver } from './baseConfigurationResolver';
import { NodeConfigurationResolver } from './nodeDebugConfigurationResolver';
import { TerminalDebugConfigurationResolver } from './terminalDebugConfigurationResolver';

const isLaunch = (
  value: ResolvingConfiguration<unknown>,
): value is ResolvingConfiguration<IChromiumLaunchConfiguration> => value.request === 'launch';

const isAttach = (
  value: ResolvingConfiguration<unknown>,
): value is ResolvingConfiguration<IChromiumAttachConfiguration> => value.request === 'attach';

/**
 * Configuration provider for Chrome debugging.
 */
@injectable()
export abstract class ChromiumDebugConfigurationResolver<T extends AnyChromiumConfiguration>
  extends BaseConfigurationResolver<T>
  implements vscode.DebugConfigurationProvider
{
  constructor(
    @inject(ExtensionContext) context: vscode.ExtensionContext,
    @inject(NodeConfigurationResolver) private readonly nodeProvider: NodeConfigurationResolver,
    @inject(TerminalDebugConfigurationResolver) private readonly terminalProvider:
      TerminalDebugConfigurationResolver,
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

    const browserLocation = this.location === 'remote' ? 'ui' : 'workspace';
    if (isLaunch(config) && !config.browserLaunchLocation) {
      config.browserLaunchLocation = browserLocation;
    }

    if (isAttach(config) && !config.browserAttachLocation) {
      config.browserAttachLocation = browserLocation;
    }

    if (config.request === 'launch') {
      const cast = config as ResolvingConfiguration<AnyChromiumLaunchConfiguration>;
      this.applyDefaultRuntimeExecutable(cast);
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
    if ('port' in config && typeof config.port === 'string') {
      config.port = Number(config.port);
    }

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
    if (cast.port && !(await isPortOpen(cast.port))) {
      return config;
    }

    const userDataDir = typeof cast.userDataDir === 'string'
      ? cast.userDataDir
      : join(
        this.extensionContext.storagePath ?? tmpdir(),
        cast.runtimeArgs?.includes('--headless') ? '.headless-profile' : '.profile',
      );

    // Warn if there's an existing instance, so we probably can't launch it in debug mode:
    const platformLock = join(
      userDataDir,
      process.platform === 'win32' ? 'lockfile' : 'SingletonLock',
    );
    const lockfileExists = await some<unknown>([
      existsWithoutDeref(this.fs, platformLock),
      this.isVsCodeLocked(join(userDataDir, 'code.lock')),
    ]);

    if (lockfileExists) {
      const debugAnyway = l10n.t('Debug Anyway');
      const result = await vscode.window.showErrorMessage(
        l10n.t(
          'It looks like a browser is already running from {0}. Please close it before trying to debug, otherwise VS Code may not be able to connect to it.',
          cast.userDataDir === true
            ? l10n.t('an old debug session')
            : l10n.t('the configured userDataDir'),
        ),
        { modal: true },
        debugAnyway,
      );

      if (result !== debugAnyway) {
        return undefined;
      }
    }

    return { ...config, userDataDir };
  }

  private async isVsCodeLocked(filepath: string) {
    try {
      const pid = Number(await this.fs.readFile(filepath, 'utf-8'));
      process.kill(pid, 0); // throws if the process does not exist
      return true;
    } catch {
      return false;
    }
  }
}

@injectable()
export abstract class ChromiumDebugConfigurationProvider<
  T extends AnyChromiumLaunchConfiguration,
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
      name: l10n.t('Launch Chrome against localhost'),
      url: 'http://localhost:8080',
      webRoot: '${workspaceFolder}',
    } as ResolvingConfiguration<T>;
  }
}
