/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { execSync, spawnSync } from 'child_process';
import { join } from 'path';
import { ILogger, LogTag } from '../../common/logging';
import { KillBehavior } from '../../configuration';

/**
 * Kills the tree of processes starting at the given parent ID.
 */
export function killTree(
  processId: number,
  logger: ILogger,
  behavior = KillBehavior.Forceful,
): boolean {
  if (behavior === KillBehavior.None) {
    return true;
  }

  if (process.platform === 'win32') {
    const windir = process.env['WINDIR'] || 'C:\\Windows';
    const TASK_KILL = join(windir, 'System32', 'taskkill.exe');

    // when killing a process in Windows its child processes are *not* killed but become root processes.
    // Therefore we use TASKKILL.EXE
    try {
      execSync(
        `${TASK_KILL} ${behavior === KillBehavior.Forceful ? '/F' : ''} /T /PID ${processId}`,
        { stdio: 'pipe' },
      );
      return true;
    } catch (err) {
      logger.error(LogTag.RuntimeException, 'Error running taskkill.exe', err);
      return false;
    }
  } else {
    // on linux and OS X we kill all direct and indirect child processes as well
    try {
      const cmd = join(__dirname, './targets/node/terminateProcess.sh');
      const r = spawnSync('sh', [
        cmd,
        processId.toString(),
        behavior === KillBehavior.Forceful ? '9' : '15',
      ]);

      if (r.stderr && r.status) {
        logger.error(LogTag.RuntimeException, 'Error running terminateProcess', r);
        return false;
      }

      return true;
    } catch (err) {
      logger.error(LogTag.RuntimeException, 'Error running terminateProcess', err);
      return false;
    }
  }
}
