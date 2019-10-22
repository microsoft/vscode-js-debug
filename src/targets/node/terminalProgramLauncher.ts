// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { INodeLaunchConfiguration } from '../../configuration';
import { ProcessLauncher } from './processLauncher';
import { ILaunchContext } from '../targets';
import { spawn, ChildProcess, spawnSync, execSync } from 'child_process';
import { removeNulls } from '../../common/objUtils';
import { join } from 'path';

/**
 * Launcher that boots a subprocess.
 */
export class TerminalProgramLauncher extends ProcessLauncher {
  private process?: ChildProcess;

  public stopProgram(): void {
    if (this.process) {
      killTree(this.process.pid);
      this.process = undefined;
    }
  }

  protected async launch(config: INodeLaunchConfiguration, context: ILaunchContext) {
    const { executable, args, shell } = formatArguments(config.runtimeExecutable || 'node', [
      ...config.runtimeArgs,
      config.program,
      ...config.args,
    ]);

    // Send an appoximation of the command we're running to
    // the terminal, for cosmetic purposes.
    context.dap.output({
      category: 'console',
      output: [executable, ...args].join(' '),
    });

    // todo: WSL support

    const process = (this.process = spawn(executable, args, {
      shell,
      cwd: config.cwd,
      env: removeNulls(config.env),
    }));

    process.stdout.addListener('data', data => {
      context.dap.output({
        category: 'stdout',
        output: data,
      });
    });

    process.stderr.addListener('data', data => {
      context.dap.output({
        category: 'stderr',
        output: data,
      });
    });

    process.on('error', err => {
      context.dap.output({
        category: 'stderr',
        output: err.stack || err.message,
      });

      this.emitProgramStop(process, null, context);
    });

    process.on('exit', code => this.emitProgramStop(process, code, context));

    return process.pid;
  }

  private emitProgramStop(process: ChildProcess, code: number | null, context: ILaunchContext) {
    if (code !== null && code !== 0) {
      context.dap.output({
        category: 'stderr',
        output:
          process === this.process
            ? `Process exited with code ${code}`
            : `Process exited with code ${code} after being killed`,
      });
    }

    if (this.process === process) {
      this.process = undefined;
    }

    this._onProgramStoppedEmitter.fire();
  }
}

// Fix for: https://github.com/microsoft/vscode/issues/45832,
// which still seems to be a thing according to the issue tracker.
// From: https://github.com/microsoft/vscode-node-debug/blob/47747454bc6e8c9e48d8091eddbb7ffb54a19bbe/src/node/nodeDebug.ts#L1120
const formatArguments = (executable: string, args: ReadonlyArray<string>) => {
  if (process.platform !== 'win32') {
    return { executable, args, shell: false };
  }

  let foundArgWithSpace = false;

  // check whether there is one arg with a space
  const output: string[] = [];
  for (const a of args) {
    if (a.includes(' ')) {
      output.push(`"${a}"`);
      foundArgWithSpace = true;
    } else {
      output.push(a);
    }
  }

  if (foundArgWithSpace) {
    return { executable, args: output, shell: true };
  }

  return { executable, args, shell: false };
};

function killTree(processId: number): void {
  if (process.platform === 'win32') {
    const windir = process.env['WINDIR'] || 'C:\\Windows';
    const TASK_KILL = join(windir, 'System32', 'taskkill.exe');

    // when killing a process in Windows its child processes are *not* killed but become root processes.
    // Therefore we use TASKKILL.EXE
    try {
      execSync(`${TASK_KILL} /F /T /PID ${processId}`);
    } catch (err) {
      // ignored
    }
  } else {
    // on linux and OS X we kill all direct and indirect child processes as well
    try {
      const cmd = join(__dirname, './terminateProcess.sh');
      spawnSync(cmd, [processId.toString()]);
    } catch (err) {
      console.log(err);
      // ignored
    }
  }
}
