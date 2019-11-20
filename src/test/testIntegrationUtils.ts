// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import del from 'del';
import { testWorkspace, testFixturesDir, TestRoot } from './test';
import { GoldenText } from './goldenText';
import * as child_process from 'child_process';
import * as path from 'path';
import { TestFunction, ExclusiveTestFunction } from 'mocha';

let servers: child_process.ChildProcess[];

before(async () => {
  servers = [
    child_process.fork(path.join(__dirname, 'testServer.js'), ['8001'], { stdio: 'pipe' }),
    child_process.fork(path.join(__dirname, 'testServer.js'), ['8002'], { stdio: 'pipe' }),
  ];

  await Promise.all(
    servers.map(server => {
      return new Promise((resolve, reject) => {
        let error = '';
        server.stderr?.on('data', data => error += data.toString());
        server.stdout?.on('data', data => error += data.toString());
        server.once('error', reject);
        server.once('close', code => reject(new Error(`Exited with ${code}, stderr=${error}`)));
        server.once('message', resolve);
      });
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

const itIntegratesBasic = (test: string, fn: (s: IIntegrationState) => Promise<void> | void, testFunction: TestFunction | ExclusiveTestFunction = it) =>
testFunction(test, async function() {
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

itIntegratesBasic.only = (test: string, fn: (s: IIntegrationState) => Promise<void> | void) => itIntegratesBasic(test, fn, it.only);
export const itIntegrates = itIntegratesBasic;

afterEach(async () => {
  await del([`${testFixturesDir}/**`], { force: true /* delete outside cwd */ });
});
