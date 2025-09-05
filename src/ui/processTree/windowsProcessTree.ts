/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { getWinUtils } from '../../common/win32Utils';
import { IProcess, IProcessTree } from './processTree';

export class WindowsProcessTree implements IProcessTree {
  /**
   * @inheritdoc
   */
  public async getWorkingDirectory() {
    return undefined; // not supported
  }

  /**
   * @inheritdoc
   */
  async lookup<T>(onEntry: (process: IProcess, accumulator: T) => T, initial: T): Promise<T> {
    const win = await getWinUtils();
    for (const proc of win.getProcessInfo()) {
      let args = '';
      let command: string;

      const quoteEnd = proc.commandLine.indexOf('" ');
      if (quoteEnd === -1) {
        const space = proc.commandLine.indexOf(' ');
        if (space === -1) {
          command = proc.commandLine;
        } else {
          command = proc.commandLine.slice(0, space);
          args = proc.commandLine.slice(space + 1);
        }
      } else {
        command = proc.commandLine.slice(1, quoteEnd);
        args = proc.commandLine.slice(quoteEnd + 2);
      }

      initial = onEntry({
        args,
        command,
        date: proc.creationDate * 1000,
        pid: proc.processId,
        ppid: proc.parentProcessId,
      }, initial);
    }

    return initial;
  }
}
