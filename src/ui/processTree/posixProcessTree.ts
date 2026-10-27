/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { DarwinProcessTree } from './darwinProcessTree';
import { IProcess } from './processTree';

export class PosixProcessTree extends DarwinProcessTree {
  /**
   * @inheritdoc
   */
  protected createProcess() {
    return this.spawn('ps', ['-axo', `pid=PID,ppid=PPID,comm:30,command=COMMAND`]);
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

      // comm is the name of the main thread, which is not always the binary:
      // Node 24 renames it to "MainThread", and a title with spaces (pm2 sets
      // "node <script>") is not a binary name. Fall back to argv[0] then.
      let pos = /\s/.test(process.command) ? -1 : process.args.indexOf(process.command);
      pos = pos === -1 ? 0 : pos + process.command.length;
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
