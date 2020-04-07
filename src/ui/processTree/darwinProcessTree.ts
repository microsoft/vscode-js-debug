/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IProcess } from './processTree';
import { BaseProcessTree } from './baseProcessTree';
import { spawnAsync, ChildProcessError } from '../../common/processUtils';
import { isAbsolute } from 'path';
import { exists } from '../../common/fsUtils';

export class DarwinProcessTree extends BaseProcessTree {
  public async getWorkingDirectory(processId: number) {
    try {
      const { stdout } = await spawnAsync('lsof', [
        // AND options
        '-a',
        // Get the cwd
        '-dcwd',
        // Filter to the cwd
        '-Fn',
        // For this process
        `-p${processId}`,
      ]);

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const cwd = stdout.trim().split('\n').pop()!.slice(1);

      return cwd && isAbsolute(cwd) && (await exists(cwd)) ? cwd : undefined;
    } catch (e) {
      if (e instanceof ChildProcessError) {
        return undefined;
      }

      throw e;
    }
  }

  /**
   * @inheritdoc
   */
  protected createProcess() {
    return this.spawn('/bin/ps', [
      '-xo',
      // The "aaaa" is needed otherwise the command name can get truncated.
      `pid=PID,ppid=PPID,comm=${'a'.repeat(256)},command=COMMAND`,
    ]);
  }

  /**
   * @inheritdoc
   */
  protected createParser(): (line: string) => IProcess | void {
    // We know PID and PPID are numbers, so we can split and trim those easily.
    // The command column is headed with "COMMAND", so the alg is to:
    // 1. Split [pid, ppid] until the third set of whitespace in the string
    // 2. Trim the binary between the third whitespace and index of COMMAND
    // 3. The COMMAND is everything else, trimmed.

    let commandOffset: number | void;
    return line => {
      if (!commandOffset) {
        commandOffset = line.indexOf('COMMAND');
        return;
      }

      const ids = /^\W*([0-9]+)\W*([0-9]+)\W*/.exec(line);
      if (!ids) {
        return;
      }

      return {
        pid: Number(ids[1]),
        ppid: Number(ids[2]),
        command: line.slice(ids[0].length, commandOffset).trim(),
        args: line.slice(commandOffset).trim(),
      };
    };
  }
}
