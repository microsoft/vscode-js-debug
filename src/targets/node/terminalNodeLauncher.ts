/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { AnyLaunchConfiguration, ITerminalLaunchConfiguration } from '../../configuration';
import * as vscode from 'vscode';
import { DebugType } from '../../common/contributionUtils';
import { NodeLauncherBase, IRunData } from './nodeLauncherBase';
import { IProgram } from './program';
import { IStopMetadata } from '../targets';
import { ProtocolError, ErrorCodes } from '../../dap/errors';

class VSCodeTerminalProcess implements IProgram {
  public readonly stopped: Promise<IStopMetadata>;

  constructor(private readonly terminal: vscode.Terminal) {
    this.stopped = new Promise(resolve => {
      const disposable = vscode.window.onDidCloseTerminal(t => {
        if (t === terminal) {
          resolve({ code: 0, killed: true });
          disposable.dispose();
        }
      });
    });
  }

  public gotTelemetery() {
    // no-op
  }

  public stop() {
    this.terminal.dispose();
    return this.stopped;
  }
}

/**
 * A special launcher which only opens a vscode terminal. Used for the
 * "debugger terminal" in the extension.
 */
export class TerminalNodeLauncher extends NodeLauncherBase<ITerminalLaunchConfiguration> {
  /**
   * @inheritdoc
   */
  protected resolveParams(
    params: AnyLaunchConfiguration,
  ): ITerminalLaunchConfiguration | undefined {
    if (params.type === DebugType.Terminal && params.request === 'launch') {
      return params;
    }

    if (params.type === DebugType.Chrome && params.server && 'command' in params.server) {
      return params.server;
    }

    return undefined;
  }

  /**
   * Launches the program.
   */
  protected async launchProgram(runData: IRunData<ITerminalLaunchConfiguration>): Promise<void> {
    // Make sure that, if we can _find_ a in their path, it's the right
    // version so that we don't mysteriously never connect fail.
    try {
      await this.resolveNodePath(runData.params);
    } catch (err) {
      if (err instanceof ProtocolError && err.cause.id === ErrorCodes.NodeBinaryOutOfDate) {
        throw err;
      }
    }

    const terminal = vscode.window.createTerminal({
      name: 'Debugger Terminal',
      cwd: runData.params.cwd,
      env: this.resolveEnvironment(runData).defined(),
    });

    terminal.show();
    this.program = new VSCodeTerminalProcess(terminal);

    if (runData.params.command) {
      terminal.sendText(runData.params.command, true);
    }
  }
}
