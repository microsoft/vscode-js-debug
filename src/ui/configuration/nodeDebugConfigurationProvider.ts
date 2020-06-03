/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as nls from 'vscode-nls';
import * as vscode from 'vscode';
import * as path from 'path';
import { injectable } from 'inversify';
import { DebugType } from '../../common/contributionUtils';
import { createLaunchConfigFromContext } from './nodeDebugConfigurationResolver';
import { BaseConfigurationProvider } from './baseConfigurationProvider';
import {
  AnyNodeConfiguration,
  AnyResolvingConfiguration,
  AnyTerminalConfiguration,
  breakpointLanguages,
  ResolvingNodeConfiguration,
  ResolvingTerminalConfiguration,
} from '../../configuration';
import { findScripts } from '../debugNpmScript';
import { flatten } from '../../common/objUtils';
import { getRunScriptCommand } from '../getRunScriptCommand';

const localize = nls.loadMessageBundle();

@injectable()
export class NodeInitialDebugConfigurationProvider extends BaseConfigurationProvider<
  AnyNodeConfiguration
> {
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
        const config = (configRaw as unknown) as { [key: string]: string | undefined };
        for (const key of keysToRelativize) {
          const value = config[key];
          if (value && path.isAbsolute(value)) {
            config[key] = path.join('${workspaceFolder}', path.relative(folder.uri.fsPath, value));
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
      type: DebugType.Terminal,
      name: localize('debug.terminal.label', 'Create JavaScript Debug Terminal'),
      request: 'launch',
      cwd: folder?.uri.fsPath,
    };

    if (!folder) {
      return [openTerminal];
    }

    const scripts = await findScripts([folder.uri.fsPath], true);
    if (!scripts) {
      return [openTerminal];
    }

    return scripts
      .map<DynamicConfig>(script => ({
        type: DebugType.Terminal,
        name: localize('node.launch.script', 'Run Script: {0}', script.name),
        request: 'launch',
        command: getRunScriptCommand(script.name, folder),
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
      !editor ||
      !breakpointLanguages.includes(editor.document.languageId) ||
      editor.document.uri.scheme !== 'file'
    ) {
      return [];
    }

    return [
      {
        type: DebugType.Node,
        name: localize('node.launch.currentFile', 'Run Current File'),
        request: 'launch',
        program: editor.document.uri.fsPath,
      },
    ];
  }
}
