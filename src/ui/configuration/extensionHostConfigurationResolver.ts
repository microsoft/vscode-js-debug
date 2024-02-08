/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import execa from 'execa';
import { promises as fs } from 'fs';
import { injectable } from 'inversify';
import { dirname, join } from 'path';
import * as vscode from 'vscode';
import { TaskCancelledError } from '../../common/cancellation';
import { DebugType } from '../../common/contributionUtils';
import { canAccess } from '../../common/fsUtils';
import { nearestDirectoryWhere } from '../../common/urlUtils';
import {
  IExtensionHostLaunchConfiguration,
  ResolvingExtensionHostConfiguration,
  applyNodeishDefaults,
  extensionHostConfigDefaults,
  resolveVariableInConfig,
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

    applyNodeishDefaults(config);

    if (config.debugWebWorkerHost) {
      config.outFiles = []; // will have a runtime script offset which invalidates any predictions
    }

    return Promise.resolve({
      ...extensionHostConfigDefaults,
      ...config,
    });
  }

  /**
   * @inheritdoc
   */
  public async resolveDebugConfigurationWithSubstitutedVariables(
    _folder: vscode.WorkspaceFolder | undefined,
    debugConfiguration: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | undefined> {
    const config = debugConfiguration as ResolvingExtensionHostConfiguration;
    try {
      const testCfg = await resolveTestConfiguration(config);
      if (testCfg) {
        config.env = { ...config.env, ...testCfg.env };
        config.args = [
          ...(config.args || []),
          `--extensionDevelopmentPath=${testCfg.extensionDevelopmentPath}`,
          `--extensionTestsPath=${testCfg.extensionTestsPath}`,
        ];
      }
    } catch (e) {
      if (e instanceof TaskCancelledError) {
        return undefined;
      }
      throw e;
    }

    return config;
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

const resolveTestConfiguration = async (config: ResolvingExtensionHostConfiguration) => {
  const { testConfiguration } = config;
  let { testConfigurationLabel } = config;
  if (!testConfiguration) {
    return;
  }

  const suffix = join('node_modules', '@vscode', 'test-cli', 'out', 'bin.mjs');
  const dirWithModules = await nearestDirectoryWhere(testConfiguration, dir => {
    const binary = join(dir, suffix);
    return canAccess(fs, binary);
  });

  if (!dirWithModules) {
    throw new Error(
      l10n.t('Cannot find `{0}` installed in {1}', '@vscode/test-cli', dirname(testConfiguration)),
    );
  }

  const result = await execa(
    process.execPath,
    [join(dirWithModules, suffix), '--config', testConfiguration, '--list-configuration'],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    },
  );

  const configs: {
    config: { label?: string };
    extensionTestsPath: string;
    extensionDevelopmentPath: string;
    env: Record<string, string>;
  }[] = JSON.parse(result.stdout);

  if (configs.length === 1) {
    return configs[0];
  }

  if (configs.length && !testConfigurationLabel) {
    testConfigurationLabel = await vscode.window.showQuickPick(
      configs.map((c, i) => c.config.label || String(i)),
      {
        title: l10n.t('Select test configuration to run'),
      },
    );
    if (!testConfigurationLabel) {
      throw new TaskCancelledError('cancelled');
    }
  }

  const found = configs.find(
    (c, i) => c.config.label === testConfigurationLabel || String(i) === testConfigurationLabel,
  );
  if (!found) {
    throw new Error(
      l10n.t(
        'Cannot find test configuration with label `{0}`, got: {1}',
        String(testConfigurationLabel),
        configs.map((c, i) => c.config.label || i).join(', '),
      ),
    );
  }

  return found;
};
