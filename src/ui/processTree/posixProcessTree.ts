/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IProcess } from './processTree';
import { DarwinProcessTree } from './darwinProcessTree';

export class PosixProcessTree extends DarwinProcessTree {
  /**
   * @inheritdoc
   */
  protected createProcess() {
    return this.spawn('/bin/ps', ['-axo', `pid=PID,ppid=PPID,comm:30,command=COMMAND`]);
  }

  /**
   * @inheritdoc
   */
  protected createParser(): (line: string) => IProcess | void {
    const parser = super.createParser();
    return line => {
      const process = parser(line);
      if (!process) {
        return;
      }

      let pos = process.args.indexOf(process.command);
      if (pos === -1) {
        return process;
      }

      pos = pos + process.command.length;
      while (pos < process.args.length) {
        if (process.args[pos] === ' ') {
          break;
        }
        pos++;
      }

      process.command = process.args.substr(0, pos);
      process.args = process.args.substr(pos + 1);
      return process;
    };
  }
}
