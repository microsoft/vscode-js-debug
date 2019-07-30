// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { spawn } from 'child_process';
import * as inspector from 'inspector';

(function() {
  if (!process.env.NODE_INSPECTOR_IPC)
    return;

  let scriptName = '';
  try {
    scriptName = require.resolve(process.argv[1]);
  } catch (e) {
  }

  const ppid = process.env.NODE_INSPECTOR_PPID || '';
  process.env.NODE_INSPECTOR_PPID = '' + process.pid;

  inspector.open(0, undefined, false);
  const parent = !!ppid;
  const waitForDebugger = process.env.NODE_INSPECTOR_WAIT_FOR_DEBUGGER === 'always' ||
      (!parent && process.env.NODE_INSPECTOR_WAIT_FOR_DEBUGGER === 'top-level');

  const info = {
    pid: String(process.pid),
    scriptName,
    inspectorURL: inspector.url(),
    waitForDebugger,
    ppid
  };

  const p = spawn(process.execPath, [__filename.replace('/bootloader.js', '/watchdog.js')], {
    env: {
      NODE_INSPECTOR_INFO: JSON.stringify(info),
      NODE_INSPECTOR_IPC: process.env.NODE_INSPECTOR_IPC
    },
    stdio: 'ignore',
    detached: true
  });
  p.unref();
  process.on('exit', () => p.kill());

  if (waitForDebugger)
    inspector.open(0, undefined, true);
})();
