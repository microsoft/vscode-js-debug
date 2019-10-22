// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { INodeLaunchConfiguration } from '../../configuration';
import { ProcessLauncher } from './processLauncher';
import { ILaunchContext } from '../targets';
import { spawn } from 'child_process';
import { SubprocessProgram } from './program';
import { EnvironmentVars } from '../../common/environmentVars';

/**
 * Launcher that boots a subprocess.
 */
export class SubprocessProgramLauncher extends ProcessLauncher {
  public canLaunch(args: INodeLaunchConfiguration) {
    return args.console === 'internalConsole';
  }

  public async launchProgram(config: INodeLaunchConfiguration, context: ILaunchContext) {
    const { executable, args, shell } = formatArguments(this.getRuntime(config), [
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

    const child = spawn(executable, args, {
      shell,
      cwd: config.cwd,
      env: EnvironmentVars.merge(process.env, config.env).defined(),
    });

    child.stdout.addListener('data', data => {
      context.dap.output({
        category: 'stdout',
        output: data.toString(),
      });
    });

    child.stderr.addListener('data', data => {
      context.dap.output({
        category: 'stderr',
        output: data.toString(),
      });
    });

    child.on('error', err => {
      context.dap.output({
        category: 'stderr',
        output: err.stack || err.message,
      });
    });

    child.on('exit', code =>
      context.dap.output({
        category: 'stderr',
        output: `Process exited with code ${code}`,
      }),
    );

    return new SubprocessProgram(child);
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
