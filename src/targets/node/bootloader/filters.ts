/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { basename } from 'path';
import { LogTag } from '../../../common/logging';
import { LeaseFile } from '../lease-file';
import { IBootloaderInfo } from './environment';
import { bootloaderLogger } from './logger';

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
  if (typeof window !== 'undefined') {
    bootloaderLogger.info(LogTag.RuntimeLaunch, 'Disabling in Electron (window is set)');
    return false;
  }

  return true;
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

/**
 * npm.cmd on windows *can* run `node C:/.../npm-cli.js prefix -g` before
 * running the script. In the integrated terminal, this can steal the debug
 * session and cause us to think it's over before it actually is.
 * @see https://github.com/microsoft/vscode-js-debug/issues/645
 */
export const checkNotNpmPrefixCheckOnWindows = () => {
  const argv = process.argv;
  return !(
    argv.length === 4
    && basename(argv[1]) === 'npm-cli.js'
    && argv[2] === 'prefix'
    && argv[3] === '-g'
  );
};

/**
 * Disable attaching to the node-gyp tree, otherwise some checks it does fails
 * since Node writes debugger information to stderr.
 * @see https://github.com/nodejs/node-gyp/blob/c3c510d89ede3a747eb679a49254052344ed8bc3/gyp/pylib/gyp/input.py#L982-L989
 * @see https://github.com/microsoft/vscode/issues/117312
 */
export const checkIsNotNodeGyp = (env: IBootloaderInfo) => {
  if (
    !!env.deferredMode
    && process.argv.length >= 2
    && basename(process.argv[1]) === 'node-gyp.js'
  ) {
    return false;
  }

  return true;
};

const allChecks = [
  checkIsNotNodeGyp,
  checkIsDebugMode,
  checkLeaseFile,
  checkNotElectron,
  checkProcessFilter,
  checkNotNpmPrefixCheckOnWindows,
];

/**
 * Checks that we're able to debug this process.
 */
export const checkAll = (env: IBootloaderInfo | undefined): env is IBootloaderInfo =>
  !!env && !allChecks.some(fn => !fn(env));
