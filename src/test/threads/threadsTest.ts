// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {TestP} from '../test';
import {GoldenText} from '../goldenText';

export function addTests(testRunner) {
  // @ts-ignore unused variables xit/fit.
  const {it, xit, fit, describe, fdescribe, xdescribe} = testRunner;

  describe('threads', () => {
    it('paused', async({p} : {p: TestP}) => {
      await p.launchUrl('index.html');
      p.cdp.Runtime.evaluate({expression: 'debugger;'});
      await p.dap.once('stopped');
      p.log(await p.dap.threads({}));
      p.assertLog();
    });

    it('not paused', async({p}: {p: TestP}) => {
      await p.launchUrl('index.html');
      p.log(await p.dap.threads({}));
      p.assertLog();
    });
  });

  describe('pause on exceptions', () => {
    async function waitForPauseOnException(p: TestP) {
      const event = p.log(await p.dap.once('stopped'));
      p.log(await p.dap.exceptionInfo({threadId: event.threadId}));
      p.log(await p.dap.continue({threadId: event.threadId}));
    }

    it('cases', async({p}: {p: TestP}) => {
      await p.launchAndLoad('blank');

      p.log('Not pausing on exceptions');
      await p.dap.setExceptionBreakpoints({filters: []});
      await p.evaluate(`setTimeout(() => { throw new Error('hello'); })`);
      await p.evaluate(`setTimeout(() => { try { throw new Error('hello'); } catch (e) {}})`);

      p.log('Pausing on uncaught exceptions');
      await p.dap.setExceptionBreakpoints({filters: ['uncaught']});
      await p.evaluate(`setTimeout(() => { try { throw new Error('hello'); } catch (e) {}})`);
      p.evaluate(`setTimeout(() => { throw new Error('hello'); })`);
      await waitForPauseOnException(p);

      p.log('Pausing on caught exceptions');
      await p.dap.setExceptionBreakpoints({filters: ['caught']});
      p.evaluate(`setTimeout(() => { throw new Error('hello'); })`);
      await waitForPauseOnException(p);
      p.evaluate(`setTimeout(() => { try { throw new Error('hello'); } catch (e) {}})`);
      await waitForPauseOnException(p);
      p.assertLog();
    });

    it('configuration', async({p}: {p: TestP}) => {
      await p.initialize;
      await p.dap.setExceptionBreakpoints({filters: ['uncaught']});
      p.launch(`
        <script>
          try {
            throw new Error('this error is caught');
          } catch (e) {
          }
          throw new Error('this error is uncaught');
        </script>
      `);
      await waitForPauseOnException(p);
      p.assertLog();
    });
  });
}

export function addStartupTests(testRunner) {
  // @ts-ignore unused variables xit/fit.
  const {it, xit, fit} = testRunner;

  it('events', async({goldenText}: {goldenText: GoldenText}) => {
    const p = new TestP(goldenText);
    p.dap.on('thread', e => p.log(e, 'Thread event: '));

    p.log('Initializing');
    // Initializing does not create a thread.
    await p.initialize;

    p.log('Launching');
    // One thread during launch.
    const launch = p.launch('blank');
    await p.dap.once('thread');

    p.log('Requesting threads');
    p.log(await p.dap.threads({}));

    await launch;
    p.log('Launched, requesting threads');
    p.log(await p.dap.threads({}));

    p.log('Disconnecting');
    await Promise.all([
      p.disconnect(),
      p.dap.once('thread')
    ]);
    p.assertLog();
  });
}
