import { spawnSync, execSync } from 'child_process';
import { join } from 'path';
import { logger } from '../../common/logging/logger';
import { LogTag } from '../../common/logging';

/**
 * Kills the tree of processes starting at the given parent ID.
 */
export function killTree(processId: number): void {
  if (process.platform === 'win32') {
    const windir = process.env['WINDIR'] || 'C:\\Windows';
    const TASK_KILL = join(windir, 'System32', 'taskkill.exe');

    // when killing a process in Windows its child processes are *not* killed but become root processes.
    // Therefore we use TASKKILL.EXE
    try {
      execSync(`${TASK_KILL} /F /T /PID ${processId}`);
    } catch (err) {
      logger.error(LogTag.RuntimeException, 'Error running taskkill.exe', err);
    }
  } else {
    // on linux and OS X we kill all direct and indirect child processes as well
    try {
      const cmd = join(__dirname, './terminateProcess.sh');
      const r = spawnSync('sh', [cmd, processId.toString()]);
      if (r.stderr && r.status) {
        logger.error(LogTag.RuntimeException, 'Error running terminateProcess', r);
      }
    } catch (err) {
      logger.error(LogTag.RuntimeException, 'Error running terminateProcess', err);
    }
  }
}
