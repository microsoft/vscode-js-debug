/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import del from 'del';
import { testWorkspace, testFixturesDir, TestRoot } from './test';
import { GoldenText } from './goldenText';
import * as child_process from 'child_process';
import * as path from 'path';

let servers: child_process.ChildProcess[];

before(async () => {
  servers = [
    child_process.fork(path.join(__dirname, 'testServer.js'), ['8001']),
    child_process.fork(path.join(__dirname, 'testServer.js'), ['8002']),
  ];

  await Promise.all(
    servers.map(server => {
      return new Promise(callback => server.once('message', callback));
    }),
  );
});

after(async () => {
  servers.forEach(server => server.kill());
  servers = [];
});

interface IIntegrationState {
  golden: GoldenText;
  r: TestRoot;
}

export const itIntegrates = (test: string, fn: (s: IIntegrationState) => Promise<void> | void) =>
  it(test, async function() {
    const golden = new GoldenText(this.test!.titlePath().join(' '), testWorkspace);
    const root = new TestRoot(golden);
    await root.initialize;

    try {
      await fn({ golden, r: root });
    } finally {
      try {
        await root.disconnect();
      } catch (e) {
        console.warn('Error disconnecting test root:', e);
      }
    }

    if (golden.hasNonAssertedLogs()) {
      throw new Error(`Whoa, test "${test}" has some logs that it did not assert!`);
    }
  });

afterEach(async () => {
  await del([`${testFixturesDir}/**`], { force: true /* delete outside cwd */ });
});
