/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IBootloaderInfo } from './environment';
import { LeaseFile } from '../lease-file';
import { bootloaderLogger } from './logger';
import { LogTag } from '../../../common/logging';

export const checkIsDebugMode = (env: IBootloaderInfo) => {
  if (!env || !env.inspectorIpc) {
    bootloaderLogger.info(LogTag.RuntimeLaunch, 'Disabling due to lack of IPC server');
    return false;
  }

  return true;
};

export const checkLeaseFile = (env: IBootloaderInfo) => {
  const leaseFile = env.requireLease;
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

export const checkProcessFilter = (env: IBootloaderInfo) => {
  let scriptName = '';
  try {
    scriptName = require.resolve(process.argv[1]);
  } catch (e) {
    scriptName = process.argv[1];
  }

  let waitForDebugger: boolean;
  try {
    waitForDebugger = new RegExp(env.waitForDebugger || '').test(scriptName);
  } catch (e) {
    waitForDebugger = true;
  }

  if (!waitForDebugger) {
    bootloaderLogger.info(LogTag.RuntimeLaunch, 'Disabling due to not matching pattern', {
      pattern: env.waitForDebugger,
      scriptName,
    });
  }

  return waitForDebugger;
};

export const checkReentrant = (env: IBootloaderInfo) => {
  if (env.ppid === process.pid) {
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
export const checkAll = (env: IBootloaderInfo | undefined): env is IBootloaderInfo =>
  !!env && !allChecks.some(fn => !fn(env));
