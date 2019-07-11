// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as test from '../test';

async function threadsOnPause(p: test.Params) {
  p.dap.launch({url: 'data:text/html,<script>debugger;</script>'});
  await p.dap.once('stopped');
  p.log(await p.dap.threads());
}

async function threadsNotOnPause(p: test.Params) {
  await p.dap.launch({url: 'data:text/html,blank'});
  p.log(await p.dap.threads());
}

async function threadEventOnStartup(log: test.Log) {
  const {adapter, dap} = await test.setup();
  dap.on('thread', e => log(e));

  log('Initializing');
  // Initializing immediately creates a thread.
  test.initialize(dap);
  await dap.once('thread');

  log('Requesting threads');
  log(await dap.threads());

  log('Launching');
  // No events during launch.
  await dap.launch({url: 'data:text/html,blank'});

  log('Disconnecting');
  const connection = await adapter.testConnection();
  await test.disconnect(connection, dap);
}

const tests = [
  threadsOnPause,
  threadsNotOnPause,
];
const startup = [
  threadEventOnStartup,
];
export default {tests, startup};
