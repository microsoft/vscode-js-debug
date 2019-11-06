// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { AnyLaunchConfiguration, INodeTerminalConfiguration } from '../../configuration';
import * as vscode from 'vscode';
import { Contributions } from '../../common/contributionUtils';
import { NodeLauncherBase, IRunData } from './nodeLauncherBase';
import { IProgram } from './program';
import { IStopMetadata } from '../targets';

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
export class TerminalNodeLauncher extends NodeLauncherBase<INodeTerminalConfiguration> {
  /**
   * @inheritdoc
   */
  protected resolveParams(params: AnyLaunchConfiguration): INodeTerminalConfiguration | undefined {
    return params.type === Contributions.TerminalDebugType ? params : undefined;
  }

  /**
   * Launches the program.
   */
  protected async launchProgram(runData: IRunData<INodeTerminalConfiguration>): Promise<void> {
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
