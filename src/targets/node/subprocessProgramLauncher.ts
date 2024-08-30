/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { inject, injectable } from 'inversify';
import { EnvironmentVars } from '../../common/environmentVars';
import { ILogger } from '../../common/logging';
import { formatSubprocessArguments } from '../../common/processUtils';
import { StreamSplitter } from '../../common/streamSplitter';
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
    const { executable, args, shell, cwd } = formatSubprocessArguments(
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
      .pipe(new EtxSplitter())
      .on('data', output => dap.output({ category: 'stdout', output: output.toString() }))
      .resume();
    child.stderr
      .pipe(new EtxSplitter())
      .on('data', output => dap.output({ category: 'stderr', output: output.toString() }))
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

const enum Char {
  ETX = 3,
}

/**
 * The ETX character is used to signal the end of a record.
 *
 * This EtxSplitter will look out for ETX characters in the stream. If it
 * finds any, it will switch from splitting the stream on newlines to
 * splitting on ETX characters.
 */
export class EtxSplitter extends StreamSplitter {
  private etxSpotted = false;

  constructor() {
    super(Char.ETX);
    this.splitSuffix = Buffer.from('\n');
  }

  override _transform(
    chunk: Buffer,
    _encoding: string,
    callback: (error?: Error | null | undefined, data?: unknown) => void,
  ): void {
    if (!this.etxSpotted && chunk.includes(Char.ETX)) {
      this.etxSpotted = true;
    }

    if (!this.etxSpotted) {
      this.push(chunk);
      return callback();
    }

    return super._transform(chunk, _encoding, callback);
  }
}
