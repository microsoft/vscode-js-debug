/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { spawn, SpawnOptionsWithoutStdio } from 'child_process';

/**
 * Thrown from {@link spawnAsync} if an error or non-zero exit code occurs.
 */
export class ChildProcessError extends Error {
  constructor(
    public readonly command: string,
    public readonly stderr: string,
    public readonly stdout: string,
    public readonly code?: number,
    public readonly innerError?: Error,
  ) {
    super(`${command} exited with code ${code || -1}: ${stderr}`);
  }
}

/**
 * Nicely wrapped `spawn` that returns stdout as a string.
 * @throws {ChildProcessError}
 */
export function spawnAsync(
  command: string,
  args: ReadonlyArray<string>,
  options?: SpawnOptionsWithoutStdio,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { ...options, stdio: 'pipe' });

    const stderr: Buffer[] = [];
    const stdout: Buffer[] = [];
    process.stderr.on('data', chunk => stderr.push(chunk));
    process.stdout.on('data', chunk => stdout.push(chunk));

    const rejectWithError = (code?: number, innerError?: Error) =>
      reject(
        new ChildProcessError(
          command,
          Buffer.concat(stderr).toString(),
          Buffer.concat(stdout).toString(),
          code,
          innerError,
        ),
      );

    process.on('error', err => rejectWithError(undefined, err));
    process.on('exit', code =>
      code
        ? rejectWithError(code)
        : resolve({
            stdout: Buffer.concat(stdout).toString(),
            stderr: Buffer.concat(stderr).toString(),
          }),
    );
  });
}
