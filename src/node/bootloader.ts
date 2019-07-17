// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { spawn } from 'child_process';
import * as inspector from 'inspector';

if (process.env.NODE_INSPECTOR_IPC) {
  let scriptName = '';
  try {
    scriptName = require.resolve(process.argv[1]);
  } catch (e) {
  }

  const ppid = process.env.NODE_INSPECTOR_PPID || '';
  process.env.NODE_INSPECTOR_PPID = '' + process.pid;

  inspector.open(0, undefined, false);

  const targetInfo = {
    targetId: String(process.pid),
    type: 'node',
    title: scriptName,
    url: inspector.url(),
    attached: true,
    openerId: ppid
  };

  const p = spawn(process.execPath, [__filename.replace('/bootloader.js', '/watchdog.js')], {
    env: {
      NODE_INSPECTOR_TARGET_INFO: JSON.stringify(targetInfo),
      NODE_INSPECTOR_IPC: process.env.NODE_INSPECTOR_IPC
    },
    stdio: 'ignore',
    detached: true
  });
  p.unref();

  inspector.open(0, undefined, true);
}
