/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

(function () {
  if (!process.env.NODE_INSPECTOR_IPC)
    return;

  let scriptName = '';
  try {
    scriptName = require.resolve(process.argv[1]);
  } catch (e) {
  }

  const ppid = process.env.INSPECTOR_PPID || '';
  process.env.INSPECTOR_PPID = '' + process.pid;
  const inspector = require('inspector');
  inspector.open(0, undefined, false);

  const base64 = new Buffer(JSON.stringify({
    cwd: process.cwd(),
    argv: process.argv.concat(process.execArgv),
    ppid: ppid,
    pid: String(process.pid),
    inspectorUrl: inspector.url(),
    scriptName: scriptName
  })).toString('base64');

  try {
    const { execFileSync } = require('child_process');
    if (process.platform === 'win32')
      execFileSync('cmd', ['/C', `echo "${base64}" > ${process.env.NODE_INSPECTOR_IPC}`]);
    else
      execFileSync('/bin/sh', ['-c', `/bin/echo ${base64} | nc -U ${process.env.NODE_INSPECTOR_IPC}`]);
  } catch (e) {
    console.log(e);
  }

  inspector.open(0, undefined, true);
})();
//# sourceURL=inspector.js
