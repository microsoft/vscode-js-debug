/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn as defaultSpawn } from 'child_process';
import { StreamSplitter } from '../../common/streamSplitter';
import { IProcess, IProcessTree } from './processTree';

/**
 * Base process tree that others can extend.
 */
export abstract class BaseProcessTree implements IProcessTree {
  constructor(protected readonly spawn = defaultSpawn) {}

  /**
   * @inheritdoc
   */
  public abstract getWorkingDirectory(processId: number): Promise<string | undefined>;

  /**
   * @inheritdoc
   */
  public lookup<T>(onEntry: (process: IProcess, accumulator: T) => T, value: T): Promise<T> {
    return new Promise((resolve, reject) => {
      const proc = this.createProcess();
      const parser = this.createParser();

      proc.on('error', reject);
      proc.stderr.on('error', data => reject(`Error finding processes: ${data.toString()}`));
      proc.stdout.pipe(new StreamSplitter('\n')).on('data', line => {
        const process = parser(line.toString());
        if (process) {
          value = onEntry(process, value);
        }
      });

      proc.on('close', (code, signal) => {
        if (code === 0) {
          resolve(value);
        } else if (signal) {
          reject(new Error(`process terminated with signal: ${signal}`));
        } else if (code) {
          reject(new Error(`process terminated with exit code: ${code}`));
        }
      });
    });
  }

  /**
   * Spawns the child process that reads data.
   */
  protected abstract createProcess(): ChildProcessWithoutNullStreams;

  /**
   * Creates a function that is called for each line of
   * the output and should parse processes.
   */
  protected abstract createParser(): (line: string) => IProcess | void;
}
