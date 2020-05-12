/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import 'reflect-metadata';

import * as inspector from 'inspector';
import * as fs from 'fs';
import * as path from 'path';
import { spawnWatchdog } from './watchdogSpawn';
import { IProcessTelemetry } from './nodeLauncherBase';
import { LogTag } from '../../common/logging';
import { onUncaughtError, ErrorType } from '../../telemetry/unhandledErrorReporter';
import { NullTelemetryReporter } from '../../telemetry/nullTelemetryReporter';
import { checkAll } from './bootloader/filters';
import { bootloaderEnv, IBootloaderEnvironment, IAutoAttachInfo } from './bootloader/environment';
import { bootloaderLogger } from './bootloader/logger';
import { spawnSync } from 'child_process';

const telemetry: IProcessTelemetry = {
  cwd: process.cwd(),
  processId: process.pid,
  nodeVersion: process.version,
  architecture: process.arch,
};

(() => {
  try {
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

    inspectOrQueue(env);

    if (env.VSCODE_DEBUGGER_ONLY_ENTRYPOINT === 'true') {
      bootloaderEnv.NODE_INSPECTOR_IPC = undefined;
    } else {
      env.NODE_INSPECTOR_PPID = String(process.pid);
    }
  } catch (e) {
    console.error(
      `Error in the js-debug bootloader, please report to https://aka.ms/js-dbg-issue: ${e.stack}`,
    );
    onUncaughtError(bootloaderLogger, new NullTelemetryReporter(), ErrorType.Exception);
  }
})();

const enum Mode {
  Immediate,
  Deferred,
  Inactive,
}

function inspectOrQueue(env: IBootloaderEnvironment) {
  const mode = !isPipeAvailable(env.NODE_INSPECTOR_IPC)
    ? Mode.Inactive
    : env.NODE_INSPECTOR_DEFERRED_MODE === 'true'
    ? Mode.Deferred
    : Mode.Immediate;

  bootloaderLogger.info(LogTag.Runtime, 'Set debug mode', { mode });
  if (mode === Mode.Inactive) {
    return;
  }

  // inspector.url() will be defined if --inspect is passed to the process.
  // Don't call it again to avoid https://github.com/nodejs/node/issues/33012
  const openedFromCli = inspector.url() !== undefined;
  if (!openedFromCli) {
    inspector.open(0, undefined, false); // first call to set the inspector.url()
  }

  const info: IAutoAttachInfo = {
    ipcAddress: env.NODE_INSPECTOR_IPC || '',
    pid: String(process.pid),
    telemetry,
    scriptName: process.argv[1],
    inspectorURL: inspector.url() as string,
    waitForDebugger: true,
    ppid: env.NODE_INSPECTOR_PPID || '',
  };

  if (mode === Mode.Immediate) {
    spawnWatchdog(env.NODE_INSPECTOR_EXEC_PATH || process.execPath, info);
  } else {
    // The bootloader must call inspector.open() synchronously, which will block
    // the event loop. Spawn the watchdog handoff in a new process to debug this.
    spawnSync(
      env.NODE_INSPECTOR_EXEC_PATH || process.execPath,
      [
        '-e',
        `const c=require("net").createConnection(process.env.NODE_INSPECTOR_IPC)` +
          `.on("connect",()=>{c.write(process.env.NODE_INSPECTOR_INFO,'utf-8',()=>c.end())})`,
      ],
      {
        env: {
          NODE_INSPECTOR_INFO: JSON.stringify(info),
          NODE_INSPECTOR_IPC: env.NODE_INSPECTOR_IPC,
        },
      },
    );
  }

  inspector.open(openedFromCli ? undefined : 0, undefined, true);
}

function isPipeAvailable(pipe?: string): pipe is string {
  if (!pipe) {
    return false;
  }

  try {
    // normally we'd use l/stat, but doing so with pipes on windows actually
    // triggers a 'connection', so do this instead...
    return fs.readdirSync(path.dirname(pipe)).includes(path.basename(pipe));
  } catch (e) {
    return false;
  }
}

/**
 * Adds process telemetry to the debugger file if necessary.
 */
function reportTelemetry() {
  const callbackFile = bootloaderEnv.VSCODE_DEBUGGER_FILE_CALLBACK;
  if (!callbackFile) {
    return;
  }

  fs.writeFileSync(callbackFile, JSON.stringify(telemetry));
  bootloaderEnv.VSCODE_DEBUGGER_FILE_CALLBACK = undefined;
}
