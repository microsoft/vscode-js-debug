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
import { IDebugConfigurationProvider } from './configurationProvider';

/**
 * Base configuration provider that handles some resolution around common
 * options and handles errors.
 */
@injectable()
export abstract class BaseConfigurationProvider<T extends AnyLaunchConfiguration>
  implements IDebugConfigurationProvider {
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
  public provideDebugConfigurations:
    | undefined
    | ((
        folder: vscode.WorkspaceFolder | undefined,
        token?: vscode.CancellationToken,
      ) => vscode.ProviderResult<vscode.DebugConfiguration[]>) = undefined;

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
   * Provides the default configuration when the user presses F5. May
   * be overridden.
   */
  /**
   * Sets the function to [rovide the default configuration when the user
   * presses F5.
   *
   * We need this roundabout assignment, because VS Code uses the presence of
   * the provideDebugConfigurations method to determine whether or not to
   * show the configuration provider in the F5 list, so it can't be a simple
   * undefined-returning abstract method.
   */
  protected setProvideDefaultConfiguration(
    fn: (
      folder: vscode.WorkspaceFolder | undefined,
      token?: vscode.CancellationToken,
    ) => undefined | ResolvingConfiguration<T> | Promise<ResolvingConfiguration<T> | undefined>,
  ): void {
    this.provideDebugConfigurations = async (folder, token) => {
      try {
        const r = await fn.call(this, folder, token);
        if (!r) {
          return [];
        }

        return r instanceof Array ? r : [r];
      } catch (err) {
        vscode.window.showErrorMessage(err.message, { modal: true });
        return [];
      }
    };
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
    if (folder) {
      config.__workspaceFolder = folder.uri.fsPath;
    } else if (config.__workspaceFolder) {
      config = resolveWorkspaceInConfig(config);
    } else {
      config = removeOptionalWorkspaceFolderUsages(config);
    }

    return config;
  }

  /**
   * Gets the type for this debug configuration.
   */
  protected abstract getType(): T['type'];
}
