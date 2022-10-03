/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable } from 'inversify';
import * as vscode from 'vscode';
import { preferredDebugTypes } from '../../common/contributionUtils';
import { AnyLaunchConfiguration, ResolvingConfiguration } from '../../configuration';
import { IDebugConfigurationProvider } from './configurationProvider';

/**
 * Base configuration provider that handles some resolution around common
 * options and handles errors.
 */
@injectable()
export abstract class BaseConfigurationProvider<T extends AnyLaunchConfiguration>
  implements IDebugConfigurationProvider
{
  /**
   * @inheritdoc
   */
  public get type() {
    return this.getType();
  }

  /**
   * @inheritdoc
   */
  public get triggerKind() {
    return this.getTriggerKind();
  }

  public async provideDebugConfigurations(
    folder: vscode.WorkspaceFolder | undefined,
    token?: vscode.CancellationToken,
  ): Promise<vscode.DebugConfiguration[]> {
    try {
      const r = await this.provide(folder, token);
      if (!r) {
        return [];
      }

      const configs = r instanceof Array ? r : [r];
      const preferredType = preferredDebugTypes.get(this.type);
      if (preferredType) {
        for (const config of configs) {
          if (config.type === this.type) {
            config.type = preferredType as T['type'];
          }
        }
      }

      return configs;
    } catch (err) {
      vscode.window.showErrorMessage(err.message, { modal: true });
      return [];
    }
  }

  protected abstract getType(): T['type'];

  protected abstract getTriggerKind(): vscode.DebugConfigurationProviderTriggerKind;

  protected abstract provide(
    folder: vscode.WorkspaceFolder | undefined,
    token?: vscode.CancellationToken,
  ):
    | Promise<ResolvingConfiguration<T>[] | ResolvingConfiguration<T>>
    | ResolvingConfiguration<T>[]
    | ResolvingConfiguration<T>;
}
