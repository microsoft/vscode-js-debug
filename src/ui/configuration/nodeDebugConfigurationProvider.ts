/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as nls from 'vscode-nls';
import * as vscode from 'vscode';
import { injectable } from 'inversify';
import { DebugType } from '../../common/contributionUtils';
import { createLaunchConfigFromContext } from './nodeDebugConfigurationResolver';
import { BaseConfigurationProvider } from './baseConfigurationProvider';
import {
  AnyNodeConfiguration,
  ResolvingNodeLaunchConfiguration,
  AnyResolvingConfiguration,
  AnyTerminalConfiguration,
  breakpointLanguages,
} from '../../configuration';
import { findScripts } from '../debugNpmScript';
import { flatten } from '../../common/objUtils';

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

type DynamicConfig = AnyResolvingConfiguration[] | undefined;

@injectable()
export class NodeDynamicDebugConfigurationProvider extends BaseConfigurationProvider<
  AnyNodeConfiguration | AnyTerminalConfiguration
> {
  protected async provide(folder?: vscode.WorkspaceFolder) {
    const candidates = await Promise.all([
      this.getFromNpmScripts(folder),
      this.getFromActiveFile(),
    ]);

    return flatten(candidates.filter((c): c is ResolvingNodeLaunchConfiguration[] => !!c));
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
  protected async getFromNpmScripts(folder?: vscode.WorkspaceFolder): Promise<DynamicConfig> {
    if (!folder) {
      return;
    }

    const scripts = await findScripts(folder, true);
    return scripts?.map(script => ({
      type: DebugType.Terminal,
      name: localize('node.launch.script', 'Run Script: {0}', script.name),
      request: 'launch',
      command: script.command,
      cwd: script.directory.uri.fsPath,
    }));
  }

  /**
   * Adds a suggestion to run the active file, if it's debuggable.
   */
  protected getFromActiveFile(): DynamicConfig {
    const editor = vscode.window.activeTextEditor;
    if (
      !editor ||
      !breakpointLanguages.includes(editor.document.languageId) ||
      editor.document.uri.scheme !== 'file'
    ) {
      return;
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
