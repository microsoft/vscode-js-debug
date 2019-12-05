/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import {
  ResolvingConfiguration,
  AnyLaunchConfiguration,
  IChromeBaseConfiguration,
} from './configuration';
import { fulfillLoggerOptions } from './common/logging';
import { mapValues } from './common/objUtils';
import { Contributions } from './common/contributionUtils';

/**
 * Base configuration provider that handles some resolution around common
 * options and handles errors.
 */
export abstract class BaseConfigurationProvider<T extends AnyLaunchConfiguration>
  implements vscode.DebugConfigurationProvider {
  constructor(protected readonly extensionContext: vscode.ExtensionContext) {}

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
  public resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    token?: vscode.CancellationToken,
  ): vscode.ProviderResult<T> {
    // We can't make the entire method async, as TS complains that it must
    // return a Promise rather than a ProviderResult.
    return (async () => {
      try {
        const resolved = await this.resolveDebugConfigurationAsync(
          folder,
          config as ResolvingConfiguration<T>,
          token,
        );
        return resolved && (await this.commonResolution(resolved));
      } catch (err) {
        vscode.window.showErrorMessage(err.message, { modal: true });
      }
    })();
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
  ): Promise<T | undefined>;

  /**
   * Fulfills resolution common between all resolver configs.
   */
  protected commonResolution(config: T): T {
    config.trace = fulfillLoggerOptions(config.trace, this.extensionContext.logPath);
    config.__workspaceCachePath = this.extensionContext.storagePath;

    // The "${webRoot}" is not a standard vscode thing--replace it appropriately.
    config.sourceMapPathOverrides = mapValues(config.sourceMapPathOverrides, value =>
      value.replace(
        '${webRoot}',
        (config.type === Contributions.ChromeDebugType &&
          (config as IChromeBaseConfiguration).webRoot) ||
          '${workspaceFolder}',
      ),
    );

    return config;
  }
}
