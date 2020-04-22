/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IBootloaderEnvironment } from './environment';
import { LeaseFile } from '../lease-file';
import { bootloaderLogger } from './logger';
import { LogTag } from '../../../common/logging';

export const checkIsDebugMode = (env: Partial<IBootloaderEnvironment>) => {
  if (!env.NODE_INSPECTOR_IPC) {
    bootloaderLogger.info(LogTag.RuntimeLaunch, 'Disabling due to lack of IPC server');
    return false;
  }

  return true;
};

export const checkLeaseFile = (env: Partial<IBootloaderEnvironment>) => {
  const leaseFile = env.NODE_INSPECTOR_REQUIRE_LEASE;
  if (leaseFile && !LeaseFile.isValid(leaseFile)) {
    bootloaderLogger.info(LogTag.RuntimeLaunch, 'Disabling due to invalid lease file');
    return false;
  }

  return true;
};

// Do not enable for Electron and other hybrid environments.
export const checkNotElectron = () => {
  try {
    eval('window');
    bootloaderLogger.info(LogTag.RuntimeLaunch, 'Disabling in Electron (window is set)');
    return false;
  } catch (e) {
    return true;
  }
};

export const checkProcessFilter = (env: Partial<IBootloaderEnvironment>) => {
  let scriptName = '';
  try {
    scriptName = require.resolve(process.argv[1]);
  } catch (e) {
    scriptName = process.argv[1];
  }

  let waitForDebugger: boolean;
  try {
    waitForDebugger = new RegExp(env.NODE_INSPECTOR_WAIT_FOR_DEBUGGER || '').test(scriptName);
  } catch (e) {
    waitForDebugger = true;
  }

  if (!waitForDebugger) {
    bootloaderLogger.info(LogTag.RuntimeLaunch, 'Disabling due to not matching pattern', {
      pattern: env.NODE_INSPECTOR_WAIT_FOR_DEBUGGER,
      scriptName,
    });
  }

  return waitForDebugger;
};

export const checkReentrant = (env: Partial<IBootloaderEnvironment>) => {
  if (env.NODE_INSPECTOR_PPID === String(process.pid)) {
    bootloaderLogger.info(LogTag.RuntimeLaunch, 'Disabling due to a duplicate bootloader');
    return false;
  }

  return true;
};

const allChecks = [
  checkIsDebugMode,
  checkLeaseFile,
  checkNotElectron,
  checkProcessFilter,
  checkReentrant,
];

/**
 * Checks that we're able to debug this process.
 */
export const checkAll = (env: Partial<IBootloaderEnvironment>): env is IBootloaderEnvironment =>
  !allChecks.some(fn => !fn(env));
