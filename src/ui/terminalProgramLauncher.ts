// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import * as path from 'path';
import * as nls from 'vscode-nls';
import { IProgramLauncher } from '../targets/node/nodeLauncher';
import { EventEmitter } from '../common/events';
import { INodeLaunchConfiguration } from '../configuration';
import { ProtocolError } from '../dap/errors';
import { findInPath, findExecutable } from '../common/pathUtils';

const localize = nls.loadMessageBundle();

/**
 * Launcher that boots a subprocess.
 */
export class TerminalProgramLauncher implements IProgramLauncher {
  private _terminal: vscode.Terminal | undefined;
  private _onProgramStoppedEmitter = new EventEmitter<void>();
  private _disposable: vscode.Disposable;

  public onProgramStopped = this._onProgramStoppedEmitter.event;

  constructor() {
    this._disposable = vscode.window.onDidCloseTerminal(terminal => {
      if (terminal === this._terminal) this._onProgramStoppedEmitter.fire();
    });
  }

  public launchProgram(args: INodeLaunchConfiguration): void {
    const env = {
      ...process.env as ({ [key: string]: string }),
      ...args.env,
    };

    let requestedRuntime = args.runtimeExecutable || 'node';
    const resolvedRuntime = findExecutable(
      path.isAbsolute(requestedRuntime) ? requestedRuntime : findInPath(requestedRuntime, env),
      env,
    );

    if (!resolvedRuntime) {
      throw new ProtocolError({
        id: 2001,
        format: localize(
          'VSND2001',
          "Cannot find runtime '{0}' on PATH. Make sure to have '{0}' installed.",
          requestedRuntime,
        ),
        showUser: true,
        variables: { _runtime: requestedRuntime },
      });
    }

    this.launch({ ...args, env, runtimeExecutable: resolvedRuntime });
  }

  public stopProgram(): void {
    if (!this._terminal) {
      return;
    }

    this._terminal.dispose();
    this._terminal = undefined;
  }

  public dispose() {
    this.stopProgram();
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
