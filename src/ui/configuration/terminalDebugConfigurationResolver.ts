/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import {
  ResolvedConfiguration,
  terminalBaseDefaults,
  ITerminalLaunchConfiguration,
} from '../../configuration';
import { BaseConfigurationResolver } from './baseConfigurationResolver';
import { guessWorkingDirectory } from './nodeDebugConfigurationResolver';
import { DebugType, runCommand, Commands } from '../../common/contributionUtils';

/**
 * Configuration provider for node debugging. In order to allow for a
 * close to 1:1 drop-in, this is nearly identical to the original vscode-
 * node-debug, with support for some legacy options (mern, useWSL) removed.
 */
export class TerminalDebugConfigurationResolver
  extends BaseConfigurationResolver<ITerminalLaunchConfiguration>
  implements vscode.DebugConfigurationProvider {
  protected async resolveDebugConfigurationAsync(
    folder: vscode.WorkspaceFolder | undefined,
    config: ResolvedConfiguration<ITerminalLaunchConfiguration>,
  ): Promise<ITerminalLaunchConfiguration | undefined> {
    if (!config.cwd) {
      config.cwd = guessWorkingDirectory(undefined, folder);
    }

    if (config.request === 'launch' && !config.command) {
      await runCommand(vscode.commands, Commands.CreateDebuggerTerminal, undefined, folder);
      return undefined;
    }

    // if a 'remoteRoot' is specified without a corresponding 'localRoot', set 'localRoot' to the workspace folder.
    // see https://github.com/Microsoft/vscode/issues/63118
    if (config.remoteRoot && !config.localRoot) {
      config.localRoot = '${workspaceFolder}';
    }

    return { ...terminalBaseDefaults, ...config };
  }

  protected getType() {
    return DebugType.Terminal as const;
  }
}
