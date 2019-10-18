// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import { INodeLaunchConfiguration } from '../configuration';
import { ProcessLauncher } from '../targets/node/processLauncher';

/**
 * Launcher that boots a subprocess.
 */
export class TerminalProgramLauncher extends ProcessLauncher {
  private _terminal: vscode.Terminal | undefined;
  private _disposable: vscode.Disposable;

  constructor() {
    super();
    this._disposable = vscode.window.onDidCloseTerminal(terminal => {
      if (terminal === this._terminal) this._onProgramStoppedEmitter.fire();
    });
  }

  public stopProgram(): void {
    if (!this._terminal) {
      return;
    }

    this._terminal.dispose();
    this._terminal = undefined;
  }

  public dispose() {
    super.dispose();
    this._disposable.dispose();
  }

  protected launch(args: INodeLaunchConfiguration) {
    // todo: should we move this to a RunInTerminalRequest in th DAP?
    this._terminal = vscode.window.createTerminal({
      name: args.name || 'Debugger terminal',
      cwd: args.cwd,
      env: args.env,
    });
    this._terminal.show();

    // todo: this is super hacky right now, get it better later
    this._terminal.sendText(
      [args.runtimeExecutable, ...args.runtimeArgs, args.program, ...args.args].join(' '),
      true,
    );
  }
}
