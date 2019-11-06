// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import {
  ResolvedConfiguration,
  ResolvingTerminalConfiguration,
  terminalBaseDefaults,
} from './configuration';
import { BaseConfigurationProvider } from './baseConfigurationProvider';
import { guessWorkingDirectory } from './nodeDebugConfigurationProvider';


/**
 * Configuration provider for node debugging. In order to allow for a
 * close to 1:1 drop-in, this is nearly identical to the original vscode-
 * node-debug, with support for some legacy options (mern, useWSL) removed.
 */
export class TerminalDebugConfigurationProvider
  extends BaseConfigurationProvider<ResolvingTerminalConfiguration>
  implements vscode.DebugConfigurationProvider {

  protected async resolveDebugConfigurationAsync(
    folder: vscode.WorkspaceFolder | undefined,
    config: ResolvingTerminalConfiguration,
  ): Promise<ResolvedConfiguration<ResolvingTerminalConfiguration> | undefined> {
    if (!config.cwd) {
      config.cwd = guessWorkingDirectory(undefined, folder);
    }

    // if a 'remoteRoot' is specified without a corresponding 'localRoot', set 'localRoot' to the workspace folder.
    // see https://github.com/Microsoft/vscode/issues/63118
    if (config.remoteRoot && !config.localRoot) {
      config.localRoot = '${workspaceFolder}';
    }

    return { ...terminalBaseDefaults, ...config };
  }
}
