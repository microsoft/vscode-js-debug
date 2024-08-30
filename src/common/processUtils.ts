/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { spawn, SpawnOptionsWithoutStdio } from 'child_process';
import { ExecaReturnValue } from 'execa';
import { platformPathToPreferredCase } from './urlUtils';

/**
 * Thrown from {@link spawnAsync} if an error or non-zero exit code occurs.
 */
export class ChildProcessError extends Error {
  public static fromExeca(result: ExecaReturnValue<string | Buffer>) {
    return new ChildProcessError(
      result.command,
      result.stderr.toString(),
      result.stdout.toString(),
      result.exitCode,
    );
  }

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
    const fmt = formatSubprocessArguments(command, args, options?.cwd);
    const process = spawn(fmt.executable, fmt.args, {
      ...options,
      cwd: fmt.cwd,
      shell: fmt.shell,
      stdio: 'pipe',
    });

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
    process.on('close', code =>
      code
        ? rejectWithError(code)
        : resolve({
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        }));
  });
}

const windowsShellScriptRe = /\.(bat|cmd)$/i;

/**
 * Formats arguments to avoid issues on Windows:
 *
 * - CVE-2024-27980 mitigation https://github.com/nodejs/node/issues/52554
 * - https://github.com/microsoft/vscode/issues/45832
 *   Note that the handling for CVE-2024-27980 applies the behavior from this
 *   issue to a superset of cases for which it originally applied.
 *
 * Originally from https://github.com/microsoft/vscode-node-debug/blob/47747454bc6e8c9e48d8091eddbb7ffb54a19bbe/src/node/nodeDebug.ts#L1120
 */
export const formatSubprocessArguments = (
  executable: string,
  args: ReadonlyArray<string>,
  cwd?: string | URL,
) => {
  if (process.platform === 'win32') {
    executable = platformPathToPreferredCase(executable);
    if (cwd) {
      cwd = platformPathToPreferredCase(cwd.toString());
    }

    if (executable.endsWith('.ps1')) {
      args = ['-File', executable, ...args];
      executable = 'powershell.exe';
    }
  }

  if (process.platform !== 'win32' || !windowsShellScriptRe.test(executable)) {
    return { executable, args, shell: false, cwd };
  }

  return {
    executable: `"${executable}"`,
    args: args.map(a => (a.includes(' ') ? `"${a}"` : a)),
    shell: true,
    cwd,
  };
};
