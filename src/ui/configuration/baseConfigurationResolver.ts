/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import { isAbsolute } from 'path';
import * as vscode from 'vscode';
import { Configuration, DebugType, readConfig } from '../../common/contributionUtils';
import { fulfillLoggerOptions } from '../../common/logging';
import { truthy } from '../../common/objUtils';
import {
  AnyLaunchConfiguration,
  removeOptionalWorkspaceFolderUsages,
  resolveWorkspaceInConfig,
  ResolvingConfiguration,
} from '../../configuration';
import { ExtensionContext } from '../../ioc-extras';
import { sourceMapSteppingEnabled } from '../sourceSteppingUI';
import { IDebugConfigurationResolver } from './configurationProvider';

/**
 * Base configuration provider that handles some resolution around common
 * options and handles errors.
 */
@injectable()
export abstract class BaseConfigurationResolver<T extends AnyLaunchConfiguration>
  implements IDebugConfigurationResolver
{
  /**
   * @inheritdoc
   */
  public get type() {
    return this.getType();
  }

  constructor(
    @inject(ExtensionContext) protected readonly extensionContext: vscode.ExtensionContext,
  ) {}

  /**
   * @inheritdoc
   */
  public async resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    token?: vscode.CancellationToken,
  ): Promise<T | null | undefined> {
    if (config.type) {
      config.type = this.getType(); // ensure type is set for aliased configurations
    }

    if ('__pendingTargetId' in config) {
      return config as T;
    }

    const castConfig = config as ResolvingConfiguration<T>;
    castConfig.sourceMaps ??= sourceMapSteppingEnabled.read(this.extensionContext.workspaceState);

    try {
      const resolved = await this.resolveDebugConfigurationAsync(folder, castConfig, token);
      return resolved && this.commonResolution(resolved, folder);
    } catch (err) {
      vscode.window.showErrorMessage(err.message, { modal: true });
    }
  }

  /**
   * Gets the default runtime executable for the type, if configured.
   */
  protected applyDefaultRuntimeExecutable(cfg: {
    type: DebugType;
    runtimeExecutable?: string | null;
  }) {
    if (cfg.runtimeExecutable) {
      return;
    }

    const allDefaults = readConfig(vscode.workspace, Configuration.DefaultRuntimeExecutables);
    const defaultValue = allDefaults ? allDefaults[cfg.type] : undefined;
    if (defaultValue) {
      cfg.runtimeExecutable = defaultValue;
    }
  }

  /**
   * Resolves the configuration for the debug adapter.
   */
  protected abstract resolveDebugConfigurationAsync(
    folder: vscode.WorkspaceFolder | undefined,
    config: ResolvingConfiguration<T>,
    token?: vscode.CancellationToken,
  ): Promise<T | null | undefined>;

  /**
   * Fulfills resolution common between all resolver configs.
   */
  protected commonResolution(config: T, folder: vscode.WorkspaceFolder | undefined): T {
    config.trace = fulfillLoggerOptions(config.trace, this.extensionContext.logPath);
    config.__workspaceCachePath = this.extensionContext.storagePath;
    config.__breakOnConditionalError =
      readConfig(vscode.workspace, Configuration.BreakOnConditionalError, folder) ?? false;

    if (folder) {
      // all good, we know the VS Code will resolve the workspace
      config.__workspaceFolder = folder.uri.fsPath;
    } else {
      // otherwise, try to manually figure out an appropriate __workspaceFolder
      // if we don't already have it.
      config.__workspaceFolder ||= this.getSuggestedWorkspaceFolders(config)
        .filter(truthy)
        .filter(f => !f.includes('${workspaceFolder}'))
        .map(f =>
          isAbsolute(f) ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(f))?.uri.fsPath : f
        )
        .find(truthy)
        || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        || '';

      // If we found it, replace appropriately. Otherwise remove the 'optional'
      // usages, there's a chance we can still make it work.
      if (config.__workspaceFolder) {
        config = resolveWorkspaceInConfig(config);
      } else {
        config = removeOptionalWorkspaceFolderUsages(config);
      }
    }

    return config;
  }

  /**
   * Gets a list of folders that might be workspace folders, if we need to
   * resolve them. This lets users set _a_ folder to be the right folder in
   * a multi-root configuration, without having to manually override every default.
   * @see https://github.com/microsoft/vscode-js-debug/issues/525
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected getSuggestedWorkspaceFolders(_config: T): (string | undefined)[] {
    return [];
  }

  /**
   * Gets the type for this debug configuration.
   */
  protected abstract getType(): T['type'];
}
