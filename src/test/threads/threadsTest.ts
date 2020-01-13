/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { TestP } from '../test';
import { itIntegrates } from '../testIntegrationUtils';

describe('threads', () => {
  itIntegrates('paused', async ({ r }) => {
    const p = await r.launchUrlAndLoad('index.html');
    p.cdp.Runtime.evaluate({ expression: 'debugger;' });
    await p.dap.once('stopped');
    p.log(await p.dap.threads({}));
    p.assertLog();
  });

  itIntegrates('not paused', async ({ r }) => {
    const p = await r.launchUrlAndLoad('index.html');
    p.log(await p.dap.threads({}));
    p.assertLog();
  });

  describe('stepping', () => {
    itIntegrates('basic', async ({ r }) => {
      const p = await r.launchUrlAndLoad('index.html');
      p.evaluate(`
        function bar() {
          return 2;
        }
        function foo() {
          debugger;
          bar();
          bar();
        }
        foo();
      `);
      const { threadId } = p.log(await p.dap.once('stopped'));
      await p.logger.logStackTrace(threadId);

      p.log('\nstep over');
      p.dap.next({ threadId });
      p.log(await Promise.all([p.dap.once('continued'), p.dap.once('stopped')]));
      await p.logger.logStackTrace(threadId);

      p.log('\nstep over');
      p.dap.next({ threadId });
      p.log(await Promise.all([p.dap.once('continued'), p.dap.once('stopped')]));
      await p.logger.logStackTrace(threadId);

      p.log('\nstep in');
      p.dap.stepIn({ threadId });
      p.log(await Promise.all([p.dap.once('continued'), p.dap.once('stopped')]));
      await p.logger.logStackTrace(threadId);

      p.log('\nstep out');
      p.dap.stepOut({ threadId });
      p.log(await Promise.all([p.dap.once('continued'), p.dap.once('stopped')]));
      await p.logger.logStackTrace(threadId);

      p.log('\nresume');
      p.dap.continue({ threadId });
      p.log(await p.dap.once('continued'));
      p.assertLog();
    });

    itIntegrates('cross thread', async ({ r }) => {
      const p = await r.launchUrlAndLoad('worker.html');

      p.cdp.Runtime.evaluate({
        expression: `debugger;\nwindow.w.postMessage('message')\n//# sourceURL=test.js`,
      });
      const { threadId } = p.log(await p.dap.once('stopped'));
      await p.logger.logStackTrace(threadId);

      p.log('\nstep over');
      p.dap.next({ threadId });
      p.log(await Promise.all([p.dap.once('continued'), p.dap.once('stopped')]));
      await p.logger.logStackTrace(threadId);

      p.log('\nstep in');
      p.dap.stepIn({ threadId });
      p.log(await p.dap.once('continued'));
      const worker = await r.worker();
      const { threadId: secondThreadId } = p.log(await worker.dap.once('stopped'));
      await worker.logger.logStackTrace(secondThreadId);

      p.log('\nresume');
      worker.dap.continue({ threadId: secondThreadId });
      p.log(await worker.dap.once('continued'));
      p.assertLog();
    });

    itIntegrates('cross thread constructor', async ({ r }) => {
      const p = await r.launchUrlAndLoad('index.html');

      p.cdp.Runtime.evaluate({
        expression: `
        debugger;
        window.w = new Worker('worker.js');\n//# sourceURL=test.js`,
      });
      const { threadId } = p.log(await p.dap.once('stopped'));
      await p.logger.logStackTrace(threadId);

      p.log('\nstep over');
      p.dap.next({ threadId });
      p.log(await Promise.all([p.dap.once('continued'), p.dap.once('stopped')]));
      await p.logger.logStackTrace(threadId);

      p.log('\nstep in');
      p.dap.stepIn({ threadId });
      p.log(await p.dap.once('continued'));
      const worker = await r.worker();
      const { threadId: secondThreadId } = p.log(await worker.dap.once('stopped'));
      await worker.logger.logStackTrace(secondThreadId);

      p.log('\nresume');
      worker.dap.continue({ threadId: secondThreadId });
      p.log(await worker.dap.once('continued'));
      p.assertLog();
    });

    itIntegrates('cross thread skip over tasks', async ({ r }) => {
      const p = await r.launchUrlAndLoad('index.html');

      p.cdp.Runtime.evaluate({
        expression: `
        window.p = new Promise(f => window.cb = f);
        debugger;
        p.then(() => {
          var a = 1; // should stop here
        });
        window.w = new Worker('worker.js');
        window.w.postMessage('hey');
        window.w.addEventListener('message', () => window.cb());
        \n//# sourceURL=test.js`,
      });
      const { threadId } = p.log(await p.dap.once('stopped'));
      await p.logger.logStackTrace(threadId);

      p.log('\nstep over');
      p.dap.next({ threadId });
      p.log(await Promise.all([p.dap.once('continued'), p.dap.once('stopped')]));
      await p.logger.logStackTrace(threadId);

      p.log('\nstep in');
      p.dap.stepIn({ threadId });
      p.log(await p.dap.once('continued'));
      const { threadId: secondThreadId } = p.log(await p.dap.once('stopped'));
      await p.logger.logStackTrace(secondThreadId);

      p.log('\nresume');
      p.dap.continue({ threadId: secondThreadId });
      p.log(await p.dap.once('continued'));
      p.assertLog();
    });

    itIntegrates.skip('cross thread constructor source map', async ({ r }) => {
      const p = await r.launchUrlAndLoad('index.html');

      p.cdp.Runtime.evaluate({
        expression: `debugger;\nwindow.w = new Worker('workerSourceMap.js');\n//# sourceURL=test.js`,
      });
      const { threadId } = p.log(await p.dap.once('stopped'));
      await p.logger.logStackTrace(threadId);

      p.log('\nstep over');
      p.dap.next({ threadId });
      p.log(await Promise.all([p.dap.once('continued'), p.dap.once('stopped')]));
      await p.logger.logStackTrace(threadId);

      p.log('\nstep in');
      p.dap.stepIn({ threadId });
      p.log(await p.dap.once('continued'));
      const worker = await r.worker();
      const { threadId: secondThreadId } = p.log(await worker.dap.once('stopped'));
      await worker.logger.logStackTrace(secondThreadId);

      p.log('\nresume');
      worker.dap.continue({ threadId: secondThreadId });
      p.log(await worker.dap.once('continued'));
      p.assertLog();
    });

    itIntegrates('cross thread source map', async ({ r }) => {
      const p = await r.launchUrlAndLoad('index.html');

      p.cdp.Runtime.evaluate({
        expression: `
        window.w = new Worker('workerSourceMap.js');
        debugger;
        window.w.postMessage('hey');\n//# sourceURL=test.js`,
      });
      const { threadId } = p.log(await p.dap.once('stopped'));
      await p.logger.logStackTrace(threadId);

      p.log('\nstep over');
      p.dap.next({ threadId });
      p.log(await Promise.all([p.dap.once('continued'), p.dap.once('stopped')]));
      await p.logger.logStackTrace(threadId);

      p.log('\nstep in');
      p.dap.stepIn({ threadId });
      p.log(await p.dap.once('continued'));
      const worker = await r.worker();
      const { threadId: secondThreadId } = p.log(await worker.dap.once('stopped'));
      await worker.logger.logStackTrace(secondThreadId);

      p.log('\nresume');
      worker.dap.continue({ threadId: secondThreadId });
      p.log(await worker.dap.once('continued'));
      p.assertLog();
    });
  });

  describe('pause on exceptions', () => {
    async function waitForPauseOnException(p: TestP) {
      const event = p.log(await p.dap.once('stopped'));
      p.log(await p.dap.exceptionInfo({ threadId: event.threadId }));
      p.log(await p.dap.continue({ threadId: event.threadId }));
    }

    itIntegrates('cases', async ({ r }) => {
      const p = await r.launchAndLoad('blank');

      p.log('Not pausing on exceptions');
      await p.dap.setExceptionBreakpoints({ filters: [] });
      await p.evaluate(`setTimeout(() => { throw new Error('hello'); })`);
      await p.evaluate(`setTimeout(() => { try { throw new Error('hello'); } catch (e) {}})`);

      p.log('Pausing on uncaught exceptions');
      await p.dap.setExceptionBreakpoints({ filters: ['uncaught'] });
      await p.evaluate(`setTimeout(() => { try { throw new Error('hello'); } catch (e) {}})`);
      p.evaluate(`setTimeout(() => { throw new Error('hello'); })`);
      await waitForPauseOnException(p);

      p.log('Pausing on caught exceptions');
      await p.dap.setExceptionBreakpoints({ filters: ['caught'] });
      p.evaluate(`setTimeout(() => { throw new Error('hello'); })`);
      await waitForPauseOnException(p);
      p.evaluate(`setTimeout(() => { try { throw new Error('hello'); } catch (e) {}})`);
      await waitForPauseOnException(p);
      p.assertLog();
    });

    itIntegrates('configuration', async ({ r }) => {
      const p = await r.launch(`
        <script>
          try {
            throw new Error('this error is caught');
          } catch (e) {
          }
          throw new Error('this error is uncaught');
        </script>
      `);
      await p.dap.setExceptionBreakpoints({ filters: ['uncaught'] });
      p.load();
      await waitForPauseOnException(p);
      p.assertLog();
    });
  });
});
