// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import { ProgramLauncher } from '../targets/node/nodeLauncher';
import { EventEmitter } from '../utils/eventUtils';

export class TerminalProgramLauncher implements ProgramLauncher {
  private _terminal: vscode.Terminal | undefined;
  private _onProgramStoppedEmitter = new EventEmitter<void>();
  private _disposable: vscode.Disposable;

  public onProgramStopped = this._onProgramStoppedEmitter.event;

  constructor() {
    this._disposable = vscode.window.onDidCloseTerminal(terminal => {
      if (terminal === this._terminal)
        this._onProgramStoppedEmitter.fire();
    });
  }

  launchProgram(name: string, cwd: string | undefined, env: { [key: string]: string | null }, command: string): void {
    this._terminal = vscode.window.createTerminal({
      name: name || 'Debugger terminal',
      cwd,
      env
    });
    this._terminal.show();
    if (command)
      this._terminal.sendText(command, true);
  }

  stopProgram(): void {
    if (!this._terminal)
      return;
    this._terminal.dispose();
    this._terminal = undefined;
  }

  dispose() {
    this.stopProgram();
    this._disposable.dispose();
  }
}
