/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as child_process from 'child_process';
import { promises as fs } from 'fs';
import { ExclusiveTestFunction, TestFunction } from 'mocha';
import * as path from 'path';
import { delay } from '../common/promiseUtil';
import { GoldenText } from './goldenText';
import { IGoldenReporterTextTest } from './reporters/goldenTextReporterUtils';
import { ITestHandle, testFixturesDir, TestRoot, testWorkspace } from './test';

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
  context: Mocha.Context & { test: Mocha.Runnable };
  golden: GoldenText;
  r: TestRoot;
}

const itIntegratesBasic = (
  test: string,
  fn: (s: IIntegrationState) => Promise<void> | void,
  testFunction: TestFunction | ExclusiveTestFunction = it,
) =>
  testFunction(test, async function() {
    if (!this.test?.file) {
      throw new Error(`Could not find file for test`);
    }

    const golden = new GoldenText(
      this.test!.titlePath().join(' '),
      this.test?.file!,
      testWorkspace,
    );
    const root = new TestRoot(golden, this.test!.fullTitle());
    await root.initialize;

    try {
      (this.test as IGoldenReporterTextTest).goldenText = golden;

      await fn({ golden, r: root, context: this as Mocha.Context & { test: Mocha.Runnable } });
    } finally {
      try {
        await root.disconnect();
      } catch (e) {
        console.warn('Error disconnecting test root:', e);
      }
    }

    if (golden.hasNonAssertedLogs()) {
      throw new Error(
        `Whoa, test "${test}" has some logs that it did not assert!\n\n${golden.getOutput()}`,
      );
    }
  });

itIntegratesBasic.only = (test: string, fn: (s: IIntegrationState) => Promise<void> | void) =>
  itIntegratesBasic(test, fn, it.only);
itIntegratesBasic.skip = (test: string, fn: (s: IIntegrationState) => Promise<void> | void) =>
  itIntegratesBasic(test, fn, it.skip);
export const itIntegrates = itIntegratesBasic;

export const eventuallyOk = async <T>(
  fn: () => Promise<T> | T,
  timeout = 1000,
  wait = 10,
): Promise<T> => {
  const deadline = Date.now() + timeout;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      if (Date.now() + wait > deadline) {
        throw e;
      }

      await delay(wait);
    }
  }
};

afterEach(async () => {
  // Retry to avoid flaking with EINVAL/EBUSY if files are written out during deletion
  for (let retries = 10; retries >= 0; retries--) {
    try {
      await fs.rm(testFixturesDir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (retries === 0) {
        throw e;
      }
      await delay(100);
    }
  }
});

export async function waitForPause(p: ITestHandle, cb?: (threadId: number) => Promise<void>) {
  const { threadId } = p.log(await p.dap.once('stopped'));
  await p.logger.logStackTrace(threadId);
  await cb?.(threadId);
  return p.dap.continue({ threadId });
}
