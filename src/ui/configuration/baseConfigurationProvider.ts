/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable } from 'inversify';
import { AnyLaunchConfiguration, ResolvingConfiguration } from '../../configuration';
import { IDebugConfigurationProvider } from './configurationProvider';
import * as vscode from 'vscode';

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

      return r instanceof Array ? r : [r];
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
