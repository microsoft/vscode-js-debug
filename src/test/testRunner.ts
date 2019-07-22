// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {TestP} from './test';
import {GoldenText} from './goldenText';
import * as child_process from 'child_process';
import * as path from 'path';

import {TestRunner, Reporter} from '@pptr/testrunner';

export async function run(): Promise<void> {
  const testRunner = new TestRunner({
    timeout: 30000,
    // Somehow "inspector" is always enabled in this electron context.
    disableTimeoutWhenInspectorIsEnabled: false,
  });
  const {beforeEach, afterEach, beforeAll, afterAll, describe} = testRunner;

  beforeAll(async (state: {server: child_process.ChildProcess}) => {
    state.server = child_process.fork(path.join(__dirname, 'testServer.js'));
    await new Promise(callback => state.server.once('message', callback));
  });

  afterAll(async (state: {server: child_process.ChildProcess}) => {
    state.server!.kill();
    delete state.server;
  });

  beforeEach(async (state, t) => {
    state.goldenText = new GoldenText(t.fullName, path.join(__dirname, '..', '..', 'testWorkspace'));
  });

  afterEach(async (state: {goldenText: GoldenText}, t) => {
    if (t.result === 'ok' && state.goldenText.hasNonAssertedLogs())
      throw new Error(`Whoa, test "${t.fullName}" has some logs that it did not assert!`);
    delete state.goldenText;
  });

  await describe('startup tests', async () => {
    (await import('./infra/infra')).addStartupTests(testRunner);
    (await import('./threads/threadsTest')).addStartupTests(testRunner);
  });

  await describe('tests', async () => {
    beforeEach(async (state: {goldenText: GoldenText, p: TestP}) => {
      state.p = new TestP(state.goldenText);
      await state.p.initialize;
    });

    afterEach(async (state) => {
      await state.p.disconnect();
      delete state.p;
    });

    (await import('./evaluate/evaluate')).addTests(testRunner);
    (await import('./sources/sourcesTest')).addTests(testRunner);
    (await import('./stacks/stacksTest')).addTests(testRunner);
    (await import('./stepping/pause')).addTests(testRunner);
    (await import('./threads/threadsTest')).addTests(testRunner);
    (await import('./variables/variablesTest')).addTests(testRunner);
    (await import('./console/consoleFormatTest')).addTests(testRunner);
    (await import('./console/consoleAPITest')).addTests(testRunner);
  });

  new Reporter(testRunner, {
    verbose: true,
    summary: false,
    showSlowTests: 0,
    projectFolder: __dirname,
  });
  await testRunner.run();
  if (process.exitCode && process.exitCode !== 0)
    throw new Error('Tests Failed');
}
