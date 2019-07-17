/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {TestP, Log} from '../test';

async function threadsOnPause(p: TestP) {
  p.dap.launch({url: 'data:text/html,<script>debugger;</script>'});
  await p.dap.once('stopped');
  p.log(await p.dap.threads());
}

async function threadsNotOnPause(p: TestP) {
  await p.dap.launch({url: 'data:text/html,blank'});
  p.log(await p.dap.threads());
}

async function threadEventOnStartup(log: Log) {
  const p = new TestP(log);
  p.dap.on('thread', e => log(e, 'Thread event: '));

  log('Initializing');
  // Initializing does not create a thread.
  await p.initialize;

  log('Launching');
  // One thread during launch.
  const launch = p.launch('data:text/html,blank');
  await p.dap.once('thread');

  log('Requesting threads');
  log(await p.dap.threads());

  await launch;
  log('Launched, requesting threads');
  log(await p.dap.threads());

  log('Disconnecting');
  await p.disconnect();
}

const tests = [
  threadsOnPause,
  threadsNotOnPause,
];
const startup = [
  threadEventOnStartup,
];
export default {tests, startup};
