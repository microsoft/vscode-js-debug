/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IProcessTree, IProcess } from './processTree';
import { spawn as defaultSpawn, ChildProcessWithoutNullStreams } from 'child_process';
import split2 from 'split2';

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
      proc.stdout.pipe(split2(/\r?\n/)).on('data', line => {
        const process = parser(line);
        if (process) {
          value = onEntry(process, value);
        }
      });

      proc.on('close', (code, signal) => {
        if (code === 0) {
          resolve(value);
        } else if (code > 0) {
          reject(new Error(`process terminated with exit code: ${code}`));
        }
        if (signal) {
          reject(new Error(`process terminated with signal: ${signal}`));
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
