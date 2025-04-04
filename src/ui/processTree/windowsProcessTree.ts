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
      const argsStart = proc.commandLine.indexOf('" ');
      initial = onEntry({
        args: argsStart !== -1 ? proc.commandLine.slice(argsStart + 2) : '',
        command: argsStart !== -1 ? proc.commandLine.slice(1, argsStart + 1) : proc.commandLine,
        date: proc.creationDate * 1000,
        pid: proc.processId,
        ppid: proc.parentProcessId,
      }, initial);
    }

    return initial;
  }
}
