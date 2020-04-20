/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import 'reflect-metadata';

import * as inspector from 'inspector';
import { writeFileSync } from 'fs';
import { spawnWatchdog } from './watchdogSpawn';
import { IProcessTelemetry } from './nodeLauncherBase';
import { LogTag } from '../../common/logging';
import { installUnhandledErrorReporter } from '../../telemetry/unhandledErrorReporter';
import { NullTelemetryReporter } from '../../telemetry/nullTelemetryReporter';
import { checkAll } from './bootloader/filters';
import { bootloaderEnv } from './bootloader/environment';
import { bootloaderLogger } from './bootloader/logger';

(() => {
  installUnhandledErrorReporter(bootloaderLogger, new NullTelemetryReporter());

  const env = bootloaderEnv;
  bootloaderLogger.info(LogTag.RuntimeLaunch, 'Bootloader imported', { env, args: process.argv });
  if (!checkAll(env)) {
    env.NODE_INSPECTOR_IPC = undefined; // save work for any children
    return;
  }

  reportTelemetry();

  if (/(\\|\/|^)node(64)?(.exe)?$/.test(process.execPath)) {
    env.NODE_INSPECTOR_EXEC_PATH = process.execPath;
  }

  bootloaderLogger.info(LogTag.Runtime, 'Entering debug mode');
  inspector.open(0, undefined, false); // first call to get the inspector.url()

  spawnWatchdog(env.NODE_INSPECTOR_EXEC_PATH || process.execPath, {
    ipcAddress: env.NODE_INSPECTOR_IPC,
    pid: String(process.pid),
    scriptName: process.argv[1],
    inspectorURL: inspector.url() as string,
    waitForDebugger: true,
    ppid: env.NODE_INSPECTOR_PPID || '',
  });

  env.NODE_INSPECTOR_PPID = String(process.pid);
  if (env.VSCODE_DEBUGGER_ONLY_ENTRYPOINT === 'true') {
    bootloaderEnv.NODE_INSPECTOR_IPC = undefined;
  }

  inspector.open(0, undefined, true); // second to wait for the debugger
})();

/**
 * Adds process telemetry to the debugger file if necessary.
 */
function reportTelemetry() {
  const callbackFile = bootloaderEnv.VSCODE_DEBUGGER_FILE_CALLBACK;
  if (!callbackFile) {
    return;
  }

  const data: IProcessTelemetry = {
    processId: process.pid,
    nodeVersion: process.version,
    architecture: process.arch,
  };

  writeFileSync(callbackFile, JSON.stringify(data));
  bootloaderEnv.VSCODE_DEBUGGER_FILE_CALLBACK = undefined;
}
