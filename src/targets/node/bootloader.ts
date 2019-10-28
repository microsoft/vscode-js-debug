// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as inspector from 'inspector';
import { writeFileSync } from 'fs';
import { spawnWatchdog } from './watchdogSpawn';
import { IProcessTelemetry } from './nodeLauncherBase';

function debugLog() {
  // require('fs').appendFileSync(require('path').join(require('os').homedir(), 'bootloader.txt'), `BOOTLOADER [${process.pid}] ${text}\n`);
}

(function() {
  debugLog();
  if (!process.env.NODE_INSPECTOR_IPC) return;

  // Electron support
  // Do not enable for Electron and other hybrid environments.
  try {
    eval('window');
    return;
  } catch (e) {}

  // If we wanted to only debug the entrypoint, unset environment variables
  // so that nested processes do not inherit them.
  if (process.env.VSCODE_DEBUGGER_ONLY_ENTRYPOINT === 'true') {
    process.env.NODE_OPTIONS = undefined;
  }

  if (process.env.VSCODE_DEBUGGER_FILE_CALLBACK) {
    const data: IProcessTelemetry = {
      processId: process.pid,
      nodeVersion: process.version,
      architecture: process.arch,
    };

    writeFileSync(process.env.VSCODE_DEBUGGER_FILE_CALLBACK, JSON.stringify(data));
    delete process.env.VSCODE_DEBUGGER_FILE_CALLBACK;
  }

  // Do not run watchdog using electron executable, stick with the cli's one.
  if (process.execPath.endsWith('node')) process.env.NODE_INSPECTOR_EXEC_PATH = process.execPath;

  let scriptName = '';
  try {
    scriptName = require.resolve(process.argv[1]);
  } catch (e) {}

  let waitForDebugger = true;
  try {
    waitForDebugger = new RegExp(process.env.NODE_INSPECTOR_WAIT_FOR_DEBUGGER || '').test(
      scriptName,
    );
  } catch (e) {}

  if (!waitForDebugger) return;

  const ppid = process.env.NODE_INSPECTOR_PPID || '';
  if (ppid === '' + process.pid) {
    // When we have two of our bootloaders in NODE_OPTIONS,
    // let the first one attach.
    return;
  }
  process.env.NODE_INSPECTOR_PPID = '' + process.pid;

  debugLog();
  inspector.open(0, undefined, false);

  const info = {
    ipcAddress: process.env.NODE_INSPECTOR_IPC,
    pid: String(process.pid),
    scriptName,
    inspectorURL: inspector.url()!,
    waitForDebugger,
    ppid,
  };

  debugLog();
  const execPath = process.env.NODE_INSPECTOR_EXEC_PATH || process.execPath;
  debugLog();

  spawnWatchdog(execPath, info);

  if (waitForDebugger) {
    debugLog();
    inspector.open(0, undefined, true);
    debugLog();
  }
})();
