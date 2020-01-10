/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as child_process from 'child_process';
import del from 'del';
import path from 'path';
import { ExclusiveTestFunction, TestFunction } from 'mocha';
import { forceForwardSlashes } from '../common/pathUtils';
import { GoldenText } from './goldenText';
import { testFixturesDir, TestRoot, testWorkspace } from './test';

process.env['DA_TEST_DISABLE_TELEMETRY'] = 'true';

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
        server.stderr?.on('data', data => (error += data.toString()));
        server.stdout?.on('data', data => (error += data.toString()));
        server.once('error', reject);
        server.once('close', code => reject(new Error(`Exited with ${code}, stderr=${error}`)));
        server.once('message', m => {
          // reject(new Error('server started' + m));
          resolve(m);
        });
        setTimeout(() => {
          reject(new Error('failed to start server'));
        }, 4000)
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

const itIntegratesBasic = (
  test: string,
  fn: (s: IIntegrationState) => Promise<void> | void,
  testFunction: TestFunction | ExclusiveTestFunction = it,
) =>
  testFunction(test, async function() {
    const golden = new GoldenText(this.test!.titlePath().join(' '), testWorkspace);
    const root = new TestRoot(golden, this.test!.fullTitle());
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

itIntegratesBasic.only = (test: string, fn: (s: IIntegrationState) => Promise<void> | void) =>
  itIntegratesBasic(test, fn, it.only);
itIntegratesBasic.skip = (test: string, fn: (s: IIntegrationState) => Promise<void> | void) =>
  itIntegratesBasic(test, fn, it.skip);
export const itIntegrates = itIntegratesBasic;

afterEach(async () => {
  await del([`${forceForwardSlashes(testFixturesDir)}/**`], {
    force: true /* delete outside cwd */,
  });
});
