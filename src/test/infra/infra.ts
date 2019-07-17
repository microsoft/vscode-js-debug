// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as test from '../test';

async function initialize(log: test.Log) {
  const p = new test.TestP(log);
  p.dap.on('initialized', () => log('initialized'));
  log(await p.initialize);
  await p.disconnect();
}

const startup = [
  initialize,
];
export default {startup};
