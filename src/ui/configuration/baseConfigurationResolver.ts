/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import {
  ResolvingConfiguration,
  AnyLaunchConfiguration,
  resolveWorkspaceInConfig,
  removeOptionalWorkspaceFolderUsages,
} from '../../configuration';
import { fulfillLoggerOptions } from '../../common/logging';
import { injectable, inject } from 'inversify';
import { ExtensionContext } from '../../ioc-extras';
import { IDebugConfigurationResolver } from './configurationProvider';
import { readConfig, Configuration } from '../../common/contributionUtils';
import { isAbsolute } from 'path';

/**
 * Base configuration provider that handles some resolution around common
 * options and handles errors.
 */
@injectable()
export abstract class BaseConfigurationResolver<T extends AnyLaunchConfiguration>
  implements IDebugConfigurationResolver {
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
    if ('__pendingTargetId' in config) {
      return config as T;
    }

    const castConfig = config as ResolvingConfiguration<T>;
    try {
      const resolved = await this.resolveDebugConfigurationAsync(folder, castConfig, token);
      return resolved && this.commonResolution(resolved, folder);
    } catch (err) {
      vscode.window.showErrorMessage(err.message, { modal: true });
    }
  }

  /**
   * Resolves the configuration for the debug adapter.
   */
  protected abstract async resolveDebugConfigurationAsync(
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
    config.__autoExpandGetters =
      readConfig(vscode.workspace, Configuration.AutoExpandGetters, folder) ?? true;

    if (folder) {
      // all good, we know the VS Code will resolve the workspace
      config.__workspaceFolder = folder.uri.fsPath;
    } else {
      // otherwise, try to manually figure out an appropriate __workspaceFolder
      // if we don't already have it.
      if (!config.__workspaceFolder) {
        config.__workspaceFolder =
          this.getSuggestedWorkspaceFolders(config)
            .filter((f): f is string => !!f && f !== '${workspaceFolder}')
            .map(f =>
              isAbsolute(f)
                ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(f))?.uri.fsPath
                : f,
            )
            .find((f): f is string => !!f) || '';
      }

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
