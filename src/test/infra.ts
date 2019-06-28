// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as test from './test';

async function initialize(log: test.Log) {
  const {adapter, dap} = await test.setup();
  dap.on('initialized', () => log('initialized'));
  log(await test.initialize(dap));
  const connection = await adapter.testConnection();
  await test.disconnect(connection, dap);
}

export default async function runTests() {
  await test.runStartupTest(initialize);
}
