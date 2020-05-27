/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import 'reflect-metadata';

import * as inspector from 'inspector';
import * as fs from 'fs';
import * as path from 'path';
import { IProcessTelemetry } from './nodeLauncherBase';
import { LogTag } from '../../common/logging';
import { onUncaughtError, ErrorType } from '../../telemetry/unhandledErrorReporter';
import { NullTelemetryReporter } from '../../telemetry/nullTelemetryReporter';
import { checkAll } from './bootloader/filters';
import { BootloaderEnvironment, IAutoAttachInfo, IBootloaderInfo } from './bootloader/environment';
import { bootloaderLogger } from './bootloader/logger';
import { spawnSync } from 'child_process';
import { spawnWatchdog } from './watchdogSpawn';

const telemetry: IProcessTelemetry = {
  cwd: process.cwd(),
  processId: process.pid,
  nodeVersion: process.version,
  architecture: process.arch,
};

(() => {
  try {
    const env = new BootloaderEnvironment(process.env);
    const inspectorOptions = env.inspectorOptions;
    bootloaderLogger.info(LogTag.RuntimeLaunch, 'Bootloader imported', {
      env: inspectorOptions,
      args: process.argv,
    });

    if (!checkAll(inspectorOptions)) {
      env.inspectorOptions = undefined; // save work for any children
      return;
    }

    reportTelemetry(env);

    if (/(\\|\/|^)node(64)?(.exe)?$/.test(process.execPath)) {
      inspectorOptions.execPath = process.execPath;
    }

    inspectOrQueue(inspectorOptions);

    if (inspectorOptions.onlyEntrypoint) {
      env.inspectorOptions = undefined;
    } else {
      env.updateInspectorOption('ppid', process.pid);
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

function inspectOrQueue(env: IBootloaderInfo) {
  const mode = !isPipeAvailable(env.inspectorIpc)
    ? Mode.Inactive
    : env.deferredMode
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
    ipcAddress: env.inspectorIpc || '',
    pid: String(process.pid),
    telemetry,
    scriptName: process.argv[1],
    inspectorURL: inspector.url() as string,
    waitForDebugger: true,
    ppid: String(env.ppid ?? ''),
  };

  if (mode === Mode.Immediate) {
    spawnWatchdog(env.execPath || process.execPath, info);
  } else {
    // The bootloader must call inspector.open() synchronously, which will block
    // the event loop. Spawn the watchdog handoff in a new process to debug this.
    spawnSync(
      env.execPath || process.execPath,
      [
        '-e',
        `const c=require("net").createConnection(process.env.NODE_INSPECTOR_IPC)` +
          `.on("connect",()=>{c.write(process.env.NODE_INSPECTOR_INFO,'utf-8',()=>c.end())})`,
      ],
      {
        env: {
          NODE_INSPECTOR_INFO: JSON.stringify(info),
          NODE_INSPECTOR_IPC: env.inspectorIpc,
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
function reportTelemetry(env: BootloaderEnvironment) {
  const callbackFile = env.inspectorOptions?.fileCallback;
  if (!callbackFile) {
    return;
  }

  fs.writeFileSync(callbackFile, JSON.stringify(telemetry));
  env.updateInspectorOption('fileCallback', undefined);
}
