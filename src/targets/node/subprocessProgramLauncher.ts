/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { inject, injectable } from 'inversify';
import split from 'split2';
import { Transform } from 'stream';
import { EnvironmentVars } from '../../common/environmentVars';
import { ILogger } from '../../common/logging';
import * as urlUtils from '../../common/urlUtils';
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
    const { executable, args, shell, cwd } = formatArguments(
      binary,
      getNodeLaunchArgs(config),
      config.cwd,
    );

    // Send an appoximation of the command we're running to
    // the terminal, for cosmetic purposes.
    context.dap.output({
      category: 'console',
      output: [executable, ...args].join(' ') + '\n',
    });

    const child = spawn(executable, args, {
      shell,
      cwd: cwd,
      env: EnvironmentVars.merge(EnvironmentVars.processEnv(), config.env).defined(),
    });

    if (config.outputCapture === OutputSource.Console) {
      this.discardStdio(context.dap, child);
    } else {
      this.captureStdio(context.dap, child);
    }

    return new SubprocessProgram(child, this.logger, config.killBehavior);
  }

  /**
   * Called for a child process when the stdio should be written over DAP.
   */
  private captureStdio(dap: Dap.Api, child: ChildProcessWithoutNullStreams) {
    child.stdout
      .pipe(EtxSplitter.stream())
      .on('data', output => dap.output({ category: 'stdout', output }))
      .resume();
    child.stderr
      .pipe(EtxSplitter.stream())
      .on('data', output => dap.output({ category: 'stderr', output }))
      .resume();
  }

  /**
   * Called for a child process when the stdio is not supposed to be captured.
   */
  private discardStdio(dap: Dap.Api, child: ChildProcessWithoutNullStreams) {
    // Catch any errors written before the debugger attaches, otherwise things
    // like module not found errors will never be written.
    let preLaunchBuffer: Buffer[] | undefined = [];
    const dumpFilter = () => {
      if (preLaunchBuffer) {
        dap.output({ category: 'stderr', output: Buffer.concat(preLaunchBuffer).toString() });
      }
    };

    const delimiter = Buffer.from('Debugger attached.');
    const errLineReader = (data: Buffer) => {
      if (data.includes(delimiter)) {
        preLaunchBuffer = undefined;
        child.stderr.removeListener('data', errLineReader);
      } else if (preLaunchBuffer) {
        preLaunchBuffer.push(data);
      }
    };

    child.stderr.on('data', errLineReader);

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

    // must be called for https://github.com/microsoft/vscode/issues/102254
    child.stdout.resume();
    child.stderr.resume();
  }
}

// Fix for: https://github.com/microsoft/vscode/issues/45832,
// which still seems to be a thing according to the issue tracker.
// From: https://github.com/microsoft/vscode-node-debug/blob/47747454bc6e8c9e48d8091eddbb7ffb54a19bbe/src/node/nodeDebug.ts#L1120
const formatArguments = (executable: string, args: ReadonlyArray<string>, cwd: string) => {
  if (process.platform === 'win32') {
    executable = urlUtils.platformPathToPreferredCase(executable);
    cwd = urlUtils.platformPathToPreferredCase(cwd);

    if (executable.endsWith('.ps1')) {
      args = ['-File', executable, ...args];
      executable = 'powershell.exe';
    }
  }

  if (process.platform !== 'win32' || !executable.includes(' ')) {
    return { executable, args, shell: false, cwd };
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
    return { executable: `"${executable}"`, args: output, shell: true, cwd: cwd };
  }

  return { executable, args, shell: false, cwd };
};

const enum Char {
  ETX = '\u0003',
}

/**
 * The ETX character is used to signal the end of a record.
 *
 * This EtxSplitter will look out for ETX characters in the stream. If it
 * finds any, it will switch from splitting the stream on newlines to
 * splitting on ETX characters.
 */
export class EtxSplitter {
  private etxSpotted = false;

  public static stream(): Transform {
    return split(new EtxSplitter());
  }

  [Symbol.split](str: string) {
    this.etxSpotted ||= str.includes(Char.ETX);
    if (!this.etxSpotted) {
      return [str, ''];
    }

    const split = str.split(Char.ETX);

    // restore or add new lines between each record for proper debug console display
    return split.length > 1 ? split.map((s, i) => (i < split.length - 1 ? `${s}\n` : s)) : split;
  }
}
