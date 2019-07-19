// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {TestP} from './test';
import {GoldenText} from './goldenText';

import {TestRunner, Reporter} from '@pptr/testrunner';

export async function run(): Promise<void> {
  const testRunner = new TestRunner({
    timeout: 10000,
    // Somehow "inspector" is always enabled in this electron context.
    disableTimeoutWhenInspectorIsEnabled: false,
  });
  const {beforeEach, afterEach, describe} = testRunner;

  beforeEach(async (state, t) => {
    state.goldenText = new GoldenText(t.name);
  });

  afterEach(async (state: {goldenText: GoldenText}, t) => {
    if (t.result === 'ok' && state.goldenText.hasNonAssertedLogs())
      throw new Error(`Whoa, test "${t.fullName}" has some logs that it did not assert!`);
    delete state.goldenText;
  });

  await describe('startup tests', async () => {
    (await import('./infra/infra')).addStartupTests(testRunner);
    (await import('./stepping/threads')).addStartupTests(testRunner);
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
    (await import('./stepping/pause')).addTests(testRunner);
    (await import('./stepping/scopes')).addTests(testRunner);
    (await import('./stepping/threads')).addTests(testRunner);
    (await import('./variables/variablesTest')).addTests(testRunner);
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
