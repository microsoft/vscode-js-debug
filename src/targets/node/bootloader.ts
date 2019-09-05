// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { spawn } from 'child_process';
import * as inspector from 'inspector';

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

  const ppid = process.env.NODE_INSPECTOR_PPID || '';
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
  debugLog('Spawning: ' + execPath + ' ' + __filename.replace('/bootloader.js', '/watchdog.js'));

  const p = spawn(execPath, [__filename.replace('/bootloader.js', '/watchdog.js')], {
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
