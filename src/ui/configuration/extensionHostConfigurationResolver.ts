/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { promises as fs } from 'fs';
import { injectable } from 'inversify';
import { join } from 'path';
import * as vscode from 'vscode';
import { DebugType } from '../../common/contributionUtils';
import {
  applyNodeishDefaults,
  extensionHostConfigDefaults,
  IExtensionHostLaunchConfiguration,
  resolveVariableInConfig,
  ResolvingExtensionHostConfiguration,
} from '../../configuration';
import { BaseConfigurationResolver } from './baseConfigurationResolver';

/**
 * Configuration provider for Extension host debugging.
 */
@injectable()
export class ExtensionHostConfigurationResolver
  extends BaseConfigurationResolver<IExtensionHostLaunchConfiguration>
  implements vscode.DebugConfigurationProvider
{
  protected async resolveDebugConfigurationAsync(
    folder: vscode.WorkspaceFolder | undefined,
    config: ResolvingExtensionHostConfiguration,
  ): Promise<IExtensionHostLaunchConfiguration | undefined> {
    if (config.debugWebWorkerHost === undefined) {
      const extensionKind = await getExtensionKind(folder, config);
      config = {
        ...config,
        debugWebWorkerHost: extensionKind.length === 1 && extensionKind[0] === 'web',
      };
    }

    if (config.debugWebWorkerHost) {
      config.outFiles = []; // will have a runtime script offset which invalidates any predictions
    }

    applyNodeishDefaults(config);

    return Promise.resolve({
      ...extensionHostConfigDefaults,
      ...config,
    });
  }

  protected getType() {
    return DebugType.ExtensionHost as const;
  }
}

const devPathArg = '--extensionDevelopmentPath=';

const getExtensionKind = async (
  folder: vscode.WorkspaceFolder | undefined,
  config: ResolvingExtensionHostConfiguration,
) => {
  const arg = config.args?.find(a => a.startsWith(devPathArg));
  if (!arg) {
    return ['workspace'];
  }

  const resolvedFolder = resolveVariableInConfig(
    arg.slice(devPathArg.length),
    'workspaceFolder',
    folder?.uri.fsPath ?? config.__workspaceFolder ?? '',
  );
  let extensionKind: string | string[];
  try {
    const json = await fs.readFile(join(resolvedFolder, 'package.json'), 'utf-8');
    extensionKind = JSON.parse(json).extensionKind ?? 'workspace';
  } catch {
    return ['workspace'];
  }

  return extensionKind instanceof Array ? extensionKind : [extensionKind];
};
