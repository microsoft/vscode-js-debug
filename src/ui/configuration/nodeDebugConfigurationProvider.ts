/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { injectable } from 'inversify';
import * as path from 'path';
import * as vscode from 'vscode';
import { DebugType, getPreferredOrDebugType } from '../../common/contributionUtils';
import { flatten } from '../../common/objUtils';
import {
  AnyNodeConfiguration,
  AnyResolvingConfiguration,
  AnyTerminalConfiguration,
  breakpointLanguages,
  ResolvingNodeConfiguration,
  ResolvingTerminalConfiguration,
} from '../../configuration';
import { findScripts } from '../debugNpmScript';
import { getPackageManager } from '../getRunScriptCommand';
import { BaseConfigurationProvider } from './baseConfigurationProvider';
import { createLaunchConfigFromContext } from './nodeDebugConfigurationResolver';

@injectable()
export class NodeInitialDebugConfigurationProvider
  extends BaseConfigurationProvider<AnyNodeConfiguration>
{
  protected provide(folder?: vscode.WorkspaceFolder) {
    return createLaunchConfigFromContext(folder, true);
  }

  protected getType() {
    return DebugType.Node as const;
  }

  protected getTriggerKind() {
    return vscode.DebugConfigurationProviderTriggerKind.Initial;
  }
}

type DynamicConfig = ResolvingNodeConfiguration | ResolvingTerminalConfiguration;

const keysToRelativize: ReadonlyArray<string> = ['cwd', 'program'];

@injectable()
export class NodeDynamicDebugConfigurationProvider extends BaseConfigurationProvider<
  AnyNodeConfiguration | AnyTerminalConfiguration
> {
  protected async provide(folder?: vscode.WorkspaceFolder) {
    const configs = flatten(
      await Promise.all([this.getFromNpmScripts(folder), this.getFromActiveFile()]),
    );

    // convert any absolute paths to directories or files to nicer ${workspaceFolder}-based paths
    if (folder) {
      for (const configRaw of configs) {
        const config = configRaw as unknown as { [key: string]: string | undefined };
        for (const key of keysToRelativize) {
          const value = config[key];
          if (value && path.isAbsolute(value)) {
            config[key] = path.join(
              '${workspaceFolder}',
              path.relative(folder.uri.fsPath, value),
            );
          }
        }
      }
    }

    return configs;
  }

  protected getType() {
    return DebugType.Node as const;
  }

  protected getTriggerKind() {
    return vscode.DebugConfigurationProviderTriggerKind.Dynamic;
  }

  /**
   * Adds suggestions discovered from npm scripts.
   */
  protected async getFromNpmScripts(folder?: vscode.WorkspaceFolder): Promise<DynamicConfig[]> {
    const openTerminal: AnyResolvingConfiguration = {
      type: getPreferredOrDebugType(DebugType.Terminal),
      name: l10n.t('JavaScript Debug Terminal'),
      request: 'launch',
      cwd: folder?.uri.fsPath,
    };

    if (!folder) {
      return [openTerminal];
    }

    const scripts = await findScripts([folder], true);
    if (!scripts) {
      return [openTerminal];
    }

    const packageManager = await getPackageManager(folder);
    return scripts
      .map<DynamicConfig>(script => ({
        type: getPreferredOrDebugType(DebugType.Terminal),
        name: l10n.t('Run Script: {0}', script.name),
        request: 'launch',
        command: `${packageManager} run ${script.name}`,
        cwd: script.directory,
      }))
      .concat(openTerminal);
  }

  /**
   * Adds a suggestion to run the active file, if it's debuggable.
   */
  protected getFromActiveFile(): DynamicConfig[] {
    const editor = vscode.window.activeTextEditor;
    if (
      !editor
      || !breakpointLanguages.includes(editor.document.languageId)
      || editor.document.uri.scheme !== 'file'
    ) {
      return [];
    }

    return [
      {
        type: getPreferredOrDebugType(DebugType.Node),
        name: l10n.t('Run Current File'),
        request: 'launch',
        program: editor.document.uri.fsPath,
      },
    ];
  }
}
