/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { AnyResolvingConfiguration, ResolvedConfiguration } from './configuration';
import { fulfillLoggerOptions } from './common/logging';

/**
 * Base configuration provider that handles some resolution around common
 * options and handles errors.
 */
export abstract class BaseConfigurationProvider<T extends AnyResolvingConfiguration>
  implements vscode.DebugConfigurationProvider {
  constructor(protected readonly extensionContext: vscode.ExtensionContext) {}

  /**
   * @inheritdoc
   */
  public resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    token?: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    // We can't make the entire method async, as TS complains that it must
    // return a Promise rather than a ProviderResult.
    return (async () => {
      try {
        const resolved = await this.resolveDebugConfigurationAsync(folder, config as T, token);
        return resolved && (await this.commonResolution(resolved));
      } catch (err) {
        vscode.window.showErrorMessage(err.message, { modal: true });
      }
    })();
  }

  /**
   * Override me!
   */
  protected abstract async resolveDebugConfigurationAsync(
    folder: vscode.WorkspaceFolder | undefined,
    config: T,
    token?: vscode.CancellationToken,
  ): Promise<ResolvedConfiguration<T> | undefined>;

  /**
   * Fulfills resolution common between all resolver configs.
   */
  protected commonResolution(config: ResolvedConfiguration<T>): ResolvedConfiguration<T> {
    config.trace = fulfillLoggerOptions(config.trace, this.extensionContext.logPath);
    return config;
  }
}
