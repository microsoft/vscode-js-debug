/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { inject, injectable } from 'inversify';
import { EnvironmentVars } from '../../common/environmentVars';
import { ILogger } from '../../common/logging';
import { INodeLaunchConfiguration, OutputSource } from '../../configuration';
import Dap from '../../dap/api';
import { ILaunchContext } from '../targets';
import { getNodeLaunchArgs, IProgramLauncher } from './processLauncher';
import { SubprocessProgram } from './program';

/**
 * Launcher that boots a subprocess.
 */
@injectable()
export class SubprocessProgramLauncher implements IProgramLauncher {
  constructor(@inject(ILogger) private readonly logger: ILogger) {}

  public canLaunch(args: INodeLaunchConfiguration) {
    return args.console === 'internalConsole';
  }

  public async launchProgram(
    binary: string,
    config: INodeLaunchConfiguration,
    context: ILaunchContext,
  ) {
    const { executable, args, shell } = formatArguments(binary, getNodeLaunchArgs(config));

    // Send an appoximation of the command we're running to
    // the terminal, for cosmetic purposes.
    context.dap.output({
      category: 'console',
      output: [executable, ...args].join(' '),
    });

    const child = spawn(executable, args, {
      shell,
      cwd: config.cwd,
      env: EnvironmentVars.merge(process.env, config.env).defined(),
    });

    if (config.outputCapture === OutputSource.Console) {
      this.discardStdio(context.dap, child);
    } else {
      this.captureStdio(context.dap, child);
    }

    return new SubprocessProgram(child, this.logger);
  }

  /**
   * Called for a child process when the stdio should be written over DAP.
   */
  private captureStdio(dap: Dap.Api, child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', data => dap.output({ category: 'stdout', output: data.toString() }));
    child.stderr.on('data', data => dap.output({ category: 'stderr', output: data.toString() }));
    child.stdout.resume();
    child.stderr.resume();
  }

  /**
   * Called for a child process when the stdio is not supposed to be captured.
   */
  private discardStdio(dap: Dap.Api, child: ChildProcessWithoutNullStreams) {
    child.stdout.resume(); // fixes https://github.com/microsoft/vscode/issues/102254

    // Catch any errors written before the debugger attaches, otherwise things
    // like module not found errors will never be written.
    let preLaunchBuffer: Buffer[] | undefined = [];
    const dumpFilter = () => {
      if (preLaunchBuffer) {
        dap.output({ category: 'stderr', output: Buffer.concat(preLaunchBuffer).toString() });
      }
    };

    const delimiter = Buffer.from('Debugger attached.');
    const errLineReader = child.stderr.on('data', (data: Buffer) => {
      if (data.includes(delimiter)) {
        preLaunchBuffer = undefined;
        errLineReader.destroy();
        setTimeout(() => child.stderr.resume(), 1);
      } else if (preLaunchBuffer) {
        preLaunchBuffer.push(data);
      }
    });

    child.on('error', err => {
      dumpFilter();
      dap.output({ category: 'stderr', output: err.stack || err.message });
    });

    child.on('exit', code => {
      if (code !== null && code > 0) {
        dumpFilter();
        dap.output({
          category: 'stderr',
          output: `Process exited with code ${code}\r\n`,
        });
      }
    });
  }
}

// Fix for: https://github.com/microsoft/vscode/issues/45832,
// which still seems to be a thing according to the issue tracker.
// From: https://github.com/microsoft/vscode-node-debug/blob/47747454bc6e8c9e48d8091eddbb7ffb54a19bbe/src/node/nodeDebug.ts#L1120
const formatArguments = (executable: string, args: ReadonlyArray<string>) => {
  if (process.platform !== 'win32' || !executable.includes(' ')) {
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
    return { executable: `"${executable}"`, args: output, shell: true };
  }

  return { executable, args, shell: false };
};
