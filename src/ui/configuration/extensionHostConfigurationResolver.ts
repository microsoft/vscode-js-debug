/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import execa from 'execa';
import { promises as fs } from 'fs';
import { injectable } from 'inversify';
import * as path from 'path';
import * as vscode from 'vscode';
import { TaskCancelledError } from '../../common/cancellation';
import { DebugType } from '../../common/contributionUtils';
import { canAccess } from '../../common/fsUtils';
import { ProcessArgs } from '../../common/processArgs';
import { nearestDirectoryWhere } from '../../common/urlUtils';
import {
  applyNodeishDefaults,
  extensionHostConfigDefaults,
  IExtensionHostLaunchConfiguration,
  resolveVariableInConfig,
  ResolvingExtensionHostConfiguration,
} from '../../configuration';
import { BaseConfigurationResolver } from './baseConfigurationResolver';

const defaultExtensionKind = ['workspace'];

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
    const args = new ProcessArgs(config.args);
    const pkgJson = await readExtensionPackageJson(folder, config, args);
    if (config.debugWebWorkerHost === undefined) {
      const extensionKind = pkgJson?.value.extensionKind ?? defaultExtensionKind;
      config = {
        ...config,
        debugWebWorkerHost: extensionKind.length === 1 && extensionKind[0] === 'web',
      };
    }

    applyNodeishDefaults(config);

    if (config.debugWebWorkerHost) {
      config.outFiles = []; // will have a runtime script offset which invalidates any predictions
    }

    if (!config.outFiles && pkgJson && folder) {
      const outFiles = await guessOutFiles(folder, pkgJson);
      if (outFiles) {
        config.outFiles = outFiles;
      }
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
          ...(testCfg.config.launchArgs || []),
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

const guessOutFiles = async (wf: vscode.WorkspaceFolder, pkgJson: IPackageJsonInfo) => {
  if (!pkgJson.value.main) {
    return undefined;
  }

  const extensionMain = path.resolve(path.dirname(pkgJson.path), pkgJson.value.main);
  const relativeToExt = path.relative(wf.uri.fsPath, path.dirname(pkgJson.path));
  const relativeToMain = path.relative(path.dirname(pkgJson.path), extensionMain);
  const subdirOfMain = relativeToMain.split(path.sep)[0];

  return [
    path.join('${workspaceFolder}', relativeToExt, subdirOfMain, '**/*.js').replaceAll('\\', '/'),
  ];
};

const devPathArg = '--extensionDevelopmentPath';

interface IPackageJsonInfo {
  path: string;
  value: {
    main?: string;
    extensionKind?: string;
  };
}

const readExtensionPackageJson = async (
  folder: vscode.WorkspaceFolder | undefined,
  config: ResolvingExtensionHostConfiguration,
  args: ProcessArgs,
): Promise<IPackageJsonInfo | undefined> => {
  const arg = args.get(devPathArg);
  if (!arg) {
    return undefined;
  }

  const resolvedFolder = resolveVariableInConfig(
    arg,
    'workspaceFolder',
    folder?.uri.fsPath ?? config.__workspaceFolder ?? '',
  );

  try {
    const pkgPath = path.join(resolvedFolder, 'package.json');
    const json = await fs.readFile(pkgPath, 'utf-8');
    return { value: JSON.parse(json), path: pkgPath };
  } catch {
    return undefined;
  }
};

const resolveTestConfiguration = async (config: ResolvingExtensionHostConfiguration) => {
  const { testConfiguration } = config;
  let { testConfigurationLabel } = config;
  if (!testConfiguration) {
    return;
  }

  const suffix = path.join('node_modules', '@vscode', 'test-cli', 'out', 'bin.mjs');
  const dirWithModules = await nearestDirectoryWhere(testConfiguration, async dir => {
    const binary = path.join(dir, suffix);
    return (await canAccess(fs, binary)) ? dir : undefined;
  });

  if (!dirWithModules) {
    throw new Error(
      l10n.t(
        'Cannot find `{0}` installed in {1}',
        '@vscode/test-cli',
        path.dirname(testConfiguration),
      ),
    );
  }

  const result = await execa(
    process.execPath,
    [path.join(dirWithModules, suffix), '--config', testConfiguration, '--list-configuration'],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    },
  );

  const configs: {
    config: { label?: string; launchArgs?: string[] };
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
