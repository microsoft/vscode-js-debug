/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable, multiInject } from 'inversify';
import * as vscode from 'vscode';
import { IConfigRefresher } from '.';
import { AnyLaunchConfiguration, AnyResolvingConfiguration } from '../../configuration';
import { IDebugConfigurationResolver } from '../configuration';

@injectable()
export class VsCodeConfigRefresher implements IConfigRefresher {
  constructor(
    @multiInject(IDebugConfigurationResolver)
    private readonly resolvers: ReadonlyArray<IDebugConfigurationResolver>,
  ) {}

  /**
   * @inheritdoc
   */
  public async refresh(
    configuration: AnyLaunchConfiguration,
  ): Promise<AnyLaunchConfiguration | undefined> {
    const folder = configuration.__workspaceFolder
      ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(configuration.__workspaceFolder))
      : undefined;

    const rawConfigs: AnyResolvingConfiguration[] | undefined = vscode.workspace
      .getConfiguration('launch', folder)
      .get('configurations');

    const raw = rawConfigs?.find(
      c =>
        (c.type === configuration.type || `pwa-${c.type}` === configuration.type) &&
        c.name === configuration.name,
    );
    if (!raw) {
      return;
    }

    const resolver = this.resolvers.find(r => r.type === configuration.type);
    const resolved = await resolver?.resolveDebugConfiguration(folder, {
      ...raw,
      type: configuration.type,
    });

    return resolved as AnyLaunchConfiguration | undefined;
  }
}
