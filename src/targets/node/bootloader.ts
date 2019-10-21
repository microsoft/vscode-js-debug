// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { spawn } from 'child_process';
import * as inspector from 'inspector';
import * as path from 'path';

function debugLog(text: string) {
  // require('fs').appendFileSync(require('path').join(require('os').homedir(), 'bootloader.txt'), `BOOTLOADER [${process.pid}] ${text}\n`);
}

(function() {
  debugLog('args: ' + process.argv.join(' '));
  if (!process.env.NODE_INSPECTOR_IPC)
    return;

  // Electron support
  // Do not enable for Electron and other hybrid environments.
  try {
    eval('window');
    return;
  } catch (e) {
  }

  // If we wanted to only debug the entrypoint, unset environment variables
  // so that nested processes do not inherit them.
  if (process.env.VSCODE_DEBUGGER_ONLY_ENTRYPOINT === 'true') {
    process.env.NODE_OPTIONS = undefined;
  }

  // Do not run watchdog using electron executable, stick with the cli's one.
  if (process.execPath.endsWith('node'))
    process.env.NODE_INSPECTOR_EXEC_PATH = process.execPath;

  let scriptName = '';
  try {
    scriptName = require.resolve(process.argv[1]);
  } catch (e) {
  }

  let waitForDebugger = true;
  try {
    waitForDebugger = new RegExp(process.env.NODE_INSPECTOR_WAIT_FOR_DEBUGGER || '').test(scriptName);
  } catch (e) {
  }

  if (!waitForDebugger)
    return;

  const kBootloader = path.sep + 'bootloader.js';
  const kWatchdog = path.sep + 'watchdog.js';
  if (!__filename.endsWith(kBootloader))
    return;
  const fileName = __filename.substring(0, __filename.length - kBootloader.length) + kWatchdog;

  const ppid = process.env.NODE_INSPECTOR_PPID || '';
  if (ppid === '' + process.pid) {
    // When we have two of our bootloaders in NODE_OPTIONS,
    // let the first one attach.
    return;
  }
  process.env.NODE_INSPECTOR_PPID = '' + process.pid;

  debugLog('Opening inspector for scriptName: ' + scriptName);
  inspector.open(0, undefined, false);

  const info = {
    pid: String(process.pid),
    scriptName,
    inspectorURL: inspector.url(),
    waitForDebugger,
    ppid
  };

  debugLog('Info: ' + JSON.stringify(info));
  const execPath = process.env.NODE_INSPECTOR_EXEC_PATH || process.execPath;
  debugLog('Spawning: ' + execPath + ' ' + fileName);

  const p = spawn(execPath, [fileName], {
    env: {
      NODE_INSPECTOR_INFO: JSON.stringify(info),
      NODE_INSPECTOR_IPC: process.env.NODE_INSPECTOR_IPC
    },
    stdio: 'ignore',
    detached: true
  });
  p.unref();
  process.on('exit', () => p.kill());

  if (waitForDebugger) {
    debugLog('Will wait for debugger');
    inspector.open(0, undefined, true);
    debugLog('Got debugger');
  }
})();
