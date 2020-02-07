/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { INodeLaunchConfiguration, OutputSource } from '../../configuration';
import { IProgramLauncher } from './processLauncher';
import { ILaunchContext } from '../targets';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { SubprocessProgram } from './program';
import { EnvironmentVars } from '../../common/environmentVars';
import Dap from '../../dap/api';
import { ILogger } from '../../common/logging';
import { injectable, inject } from 'inversify';

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
    let execArgs = [...config.runtimeArgs, ...config.args];
    if (config.program) {
      execArgs = [...config.runtimeArgs, config.program, ...config.args];
    }

    const { executable, args, shell } = formatArguments(binary, execArgs);

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

    this.setupStdio(config, context.dap, child);

    return new SubprocessProgram(child, this.logger);
  }

  private setupStdio(
    config: INodeLaunchConfiguration,
    dap: Dap.Api,
    child: ChildProcessWithoutNullStreams,
  ) {
    const captureOutput = config.outputCapture === OutputSource.Stdio;
    const filter = captureOutput ? null : new SubprocessMessageFilter();
    const dumpFilter = () =>
      filter &&
      dap.output({
        category: 'stderr',
        output: filter.dump(),
      });

    if (captureOutput) {
      child.stdout.addListener('data', data => {
        dap.output({
          category: 'stdout',
          output: data.toString(),
        });
      });
    }

    child.stderr.addListener('data', data => {
      if (!filter || filter.test(data)) {
        dap.output({
          category: 'stderr',
          output: data.toString(),
        });
      }
    });

    child.on('error', err => {
      dumpFilter();
      dap.output({
        category: 'stderr',
        output: err.stack || err.message,
      });
    });

    child.on('exit', code => {
      dumpFilter();
      dap.output({
        category: 'stderr',
        output: `Process exited with code ${code}\r\n`,
      });
    });
  }
}

/**
 * Small utility to filder stderr messages when output is set to 'console'.
 * We want to display the initial "debugger" messages, and we also keep a small
 * ring buffer in here so that we can dump stderr if the process exits with
 * an unexpected clode.
 */
export class SubprocessMessageFilter {
  private messages: string[] = [];
  private messageIndex = 0;
  private finishedReading = false;

  constructor(bufferSize = 15) {
    while (this.messages.length < bufferSize) {
      this.messages.push('');
    }
  }

  public test(message: string) {
    if (message.includes('Debugger attached')) {
      this.finishedReading = true;
      return true;
    }

    if (!this.finishedReading) {
      return true;
    }

    this.messages[this.messageIndex++ % this.messages.length] = message;
    return false;
  }

  public dump(): string {
    const result: string[] = [];

    for (let i = 0; ; i++) {
      if (i === this.messages.length) {
        result.push(
          `--- Truncated to last ${this.messages.length} messages, set outputCapture to 'all' to see more ---\r\n`,
        );
        break;
      }

      const index = (this.messageIndex - 1 - i) % this.messages.length;
      if (index < 0) {
        break;
      }

      result.push(this.messages[index]);
    }

    return result.reverse().join('');
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
