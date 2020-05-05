/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { spawn } from 'child_process';
import { join } from 'path';

export interface IWatchdogInfo {
  /**
   * Observed process ID.
   */
  pid?: string;

  /**
   * If set to true, this indicates that the process the watchdog is monitoring
   * was not started with the bootloader. In order to debug it, we must tell
   * CDP to force it into debugging mode manually.
   */
  dynamicAttach?: boolean;

  /**
   * Process script name, for cosmetic purposes.
   */
  scriptName: string;

  /**
   * URL of the inspector running on the process.
   */
  inspectorURL: string;

  /**
   * Address on the debugging server to attach to.
   */
  ipcAddress: string;

  /**
   * Whether the process is waiting for the debugger to attach.
   */
  waitForDebugger: boolean;

  /**
   * Parent process ID.
   */
  ppid?: string;
}

export const watchdogPath = join(__dirname, 'watchdog.bundle.js');
export const bootloaderDefaultPath = join(__dirname, 'bootloader.bundle.js');

/**
 * Spawns a watchdog attached to the given process.
 */
export function spawnWatchdog(execPath: string, { ipcAddress, ...inspectorInfo }: IWatchdogInfo) {
  const p = spawn(execPath, [watchdogPath], {
    env: {
      NODE_INSPECTOR_INFO: JSON.stringify(inspectorInfo),
      NODE_INSPECTOR_IPC: ipcAddress,
    },
    stdio: 'ignore',
    detached: true,
  });
  p.unref();
  process.on('exit', () => p.kill());

  return p;
}
