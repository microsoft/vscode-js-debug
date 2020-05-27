/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as child_process from 'child_process';
import del from 'del';
import { ExclusiveTestFunction, TestFunction } from 'mocha';
import * as path from 'path';
import { GoldenText } from './goldenText';
import { testFixturesDir, TestRoot, testWorkspace, ITestHandle } from './test';
import { forceForwardSlashes } from '../common/pathUtils';
import { IGoldenReporterTextTest } from './reporters/goldenTextReporterUtils';
import { delay } from '../common/promiseUtil';

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
  testFunction(test, async function () {
    const golden = new GoldenText(this.test!.titlePath().join(' '), testWorkspace);
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
  await del([`${forceForwardSlashes(testFixturesDir)}/**`], {
    force: true /* delete outside cwd */,
  });
});

export async function waitForPause(p: ITestHandle, cb?: (threadId: string) => Promise<void>) {
  const { threadId } = p.log(await p.dap.once('stopped'));
  await p.logger.logStackTrace(threadId);
  await cb?.(threadId);
  return p.dap.continue({ threadId });
}
