// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { EventEmitter } from '../../common/events';
import * as childProcess from 'child_process';
import { ProgramLauncher } from './nodeLauncher';

export class ChildProcessProgramLauncher implements ProgramLauncher {
  private _onProgramStoppedEmitter = new EventEmitter<void>();
  public onProgramStopped = this._onProgramStoppedEmitter.event;
  private _process?: childProcess.ChildProcess;
  private _stop: () => void;

  constructor() {
    this._stop = this.stopProgram.bind(this);
  }

  launchProgram(name: string, cwd: string | undefined, env: { [key: string]: string | null }, command: string): void {
    // TODO: implement this for Windows.
    const isWindows = process.platform === 'win32';
    if (process.platform !== 'linux' && process.platform !== 'darwin')
      return;

    let bash = '';
    try {
      bash = childProcess.execFileSync('which', ['bash'], { stdio: 'pipe' }).toString().split(/\r?\n/)[0];
    } catch (e) {
      return;
    }

    this._process = childProcess.spawn(
      bash,
      ["-c", command],
      {
        cwd,
        // On non-windows platforms, `detached: false` makes child process a leader of a new
        // process group, making it possible to kill child process tree with `.kill(-pid)` command.
        // @see https://nodejs.org/api/child_process.html#child_process_options_detached
        detached: !isWindows,
        env
      }
    );
    process.on('exit', this._stop);
    if (this._process.pid === undefined)
      this.stopProgram();
  }

  stopProgram() {
    if (!this._process)
      return;
    process.removeListener('exit', this._stop);
    if (this._process.pid && !this._process.killed) {
      // Force kill browser.
      try {
        if (process.platform === 'win32')
          childProcess.execSync(`taskkill /pid ${this._process.pid} /T /F`);
        else
          process.kill(-this._process.pid, 'SIGKILL');
      } catch (e) {
        // the process might have already stopped
      }
    }
    this._process = undefined;
  }

  dispose() {
    this.stopProgram();
  }
}