/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { TestP, testWorkspace } from '../test';
import { itIntegrates } from '../testIntegrationUtils';
import { Dap } from '../../dap/api';
import { delay } from '../../common/promiseUtil';

describe('stacks', () => {
  async function dumpStackAndContinue(p: TestP, scopes: boolean) {
    const event = await p.dap.once('stopped');
    await p.logger.logStackTrace(event.threadId!, scopes);
    await p.dap.continue({ threadId: event.threadId! });
  }

  itIntegrates('eval in anonymous', async ({ r }) => {
    const p = await r.launchAndLoad('blank');
    p.cdp.Runtime.evaluate({ expression: '\n\ndebugger;\n//# sourceURL=eval.js' });
    await dumpStackAndContinue(p, false);
    p.assertLog();
  });

  itIntegrates('anonymous initial script', async ({ r }) => {
    const p = await r.launch('<script>debugger;</script>');
    p.load();
    await dumpStackAndContinue(p, false);
    p.assertLog();
  });

  itIntegrates('anonymous scopes', async ({ r }) => {
    const p = await r.launchAndLoad('blank');
    p.cdp.Runtime.evaluate({
      expression: `
      function paused() {
        let y = 'paused';
        debugger;
      }
      function chain(n) {
        if (!n)
          return paused;
        return function chained() {
          let x = 'x' + n;
          chain(n - 1)();
        };
      }
      chain(3)();
    `,
    });
    await dumpStackAndContinue(p, true);
    p.assertLog();
  });

  itIntegrates('async', async ({ r }) => {
    const p = await r.launchAndLoad('blank');
    p.cdp.Runtime.evaluate({
      expression: `
      function foo(n) {
        if (!n) {
          debugger;
          return;
        }
        setTimeout(() => {
          bar(n - 1);
        }, 0);
      }
      async function bar(n) {
        await Promise.resolve(15);
        await foo(n);
      }
      bar(1);
    `,
    });
    await dumpStackAndContinue(p, true);
    p.assertLog();
  });

  itIntegrates('async disables', async ({ r }) => {
    const p = await r.launchAndLoad('blank', { showAsyncStacks: false });
    p.cdp.Runtime.evaluate({
      expression: `
      function foo(n) {
        if (!n) {
          debugger;
          return;
        }
        setTimeout(() => {
          bar(n - 1);
        }, 0);
      }
      async function bar(n) {
        await Promise.resolve(15);
        await foo(n);
      }
      bar(1);
    `,
    });
    await dumpStackAndContinue(p, true);
    p.assertLog();
  });

  itIntegrates('cross target', async ({ r }) => {
    const p = await r.launchUrlAndLoad('worker.html');
    p.cdp.Runtime.evaluate({ expression: `window.w.postMessage('pause')` });
    await dumpStackAndContinue(p, true);
    p.assertLog();
  });

  itIntegrates('source map', async ({ r }) => {
    const p = await r.launchUrlAndLoad('index.html');
    p.addScriptTag('browserify/pause.js');
    await dumpStackAndContinue(p, true);
    p.assertLog();
  });

  describe('smartStep', () => {
    itIntegrates('simple stepping', async ({ r }) => {
      const p = await r.launchUrlAndLoad('index.html');
      p.addScriptTag('smartStep/async.js');
      const { threadId } = await p.dap.once('stopped');
      await p.dap.next({ threadId: threadId! });

      await p.dap.once('stopped');
      await p.logger.logStackTrace(threadId!);

      await p.dap.stepIn({ threadId: threadId! });
      await p.dap.stepIn({ threadId: threadId! });
      await dumpStackAndContinue(p, false);
      p.assertLog();
    });

    itIntegrates('does not smart step on exception breakpoints', async ({ r }) => {
      const p = await r.launchUrlAndLoad('index.html');
      await p.dap.setExceptionBreakpoints({ filters: ['uncaught', 'caught'] });
      p.addScriptTag('smartStep/exceptionBp.js');
      await dumpStackAndContinue(p, false);
      p.assertLog();
    });

    itIntegrates('does not smart step manual breakpoints', async ({ r }) => {
      const p = await r.launchUrlAndLoad('index.html');
      await p.dap.setBreakpoints({
        source: { path: p.workspacePath('web/smartStep/exceptionBp.js') },
        breakpoints: [{ line: 9, column: 0 }],
      });
      p.addScriptTag('smartStep/exceptionBp.js');
      await dumpStackAndContinue(p, false);
      p.assertLog();
    });
  });

  itIntegrates('return value', async ({ r }) => {
    const p = await r.launchAndLoad('blank');
    p.cdp.Runtime.evaluate({
      expression: `
      function foo() {
        debugger;
        return 42;
      }
      foo();
    `,
    });
    const { threadId } = await p.dap.once('stopped'); // debugger
    p.dap.next({ threadId: threadId! });
    await p.dap.once('stopped'); // return 42
    p.dap.next({ threadId: threadId! });
    await dumpStackAndContinue(p, true); // exit point
    p.assertLog();
  });

  describe('skipFiles', () => {
    async function waitForPausedThenDelayStackTrace(p: TestP, scopes: boolean) {
      const event = await p.dap.once('stopped');
      await delay(200); // need to pause test to let debouncer update scripts
      await p.logger.logStackTrace(event.threadId!, scopes);
    }

    itIntegrates('single authored js', async ({ r }) => {
      const p = await r.launchUrl('script.html', { skipFiles: ['**/script.js'] });
      const source: Dap.Source = {
        path: p.workspacePath('web/script.js'),
      };
      await p.dap.setBreakpoints({ source, breakpoints: [{ line: 6, column: 0 }] });
      p.load();
      await waitForPausedThenDelayStackTrace(p, false);
      p.assertLog();
    });

    itIntegrates('single compiled js', async ({ r }) => {
      const p = await r.launchUrlAndLoad('basic.html', { skipFiles: ['**/basic.js'] });
      const source: Dap.Source = {
        path: p.workspacePath('web/basic.js'),
      };
      await p.dap.setBreakpoints({ source, breakpoints: [{ line: 3, column: 0 }] });
      p.load();
      await waitForPausedThenDelayStackTrace(p, false);
      p.assertLog();
    });

    itIntegrates('multiple authored ts to js', async ({ r }) => {
      const p = await r.launchUrl('browserify/pause.html', { skipFiles: ['**/module*.ts'] });
      await delay(500); // need to pause test to let debouncer update scripts
      const source: Dap.Source = {
        path: p.workspacePath('web/browserify/module1.ts'),
      };
      await p.dap.setBreakpoints({ source, breakpoints: [{ line: 3, column: 0 }] });
      p.load();
      await waitForPausedThenDelayStackTrace(p, false);
      p.assertLog();
    });

    itIntegrates('works with absolute paths (#470)', async ({ r }) => {
      const p = await r.launchUrl('basic.html', {
        skipFiles: [`${testWorkspace}/web/basic.js`],
      });
      const source: Dap.Source = {
        path: p.workspacePath('web/basic.js'),
      };
      await p.dap.setBreakpoints({ source, breakpoints: [{ line: 3, column: 0 }] });
      p.load();
      await waitForPausedThenDelayStackTrace(p, false);
      p.assertLog();
    });

    itIntegrates('toggle authored ts', async ({ r }) => {
      const p = await r.launchUrlAndLoad('basic.html');
      const path = p.workspacePath('web/basic.ts');
      const source: Dap.Source = {
        path: path,
      };
      await p.dap.setBreakpoints({ source, breakpoints: [{ line: 21, column: 0 }] });
      p.load();

      const event = await p.dap.once('stopped');
      await delay(500); // need to pause test to let debouncer update scripts
      await p.logger.logStackTrace(event.threadId!, false);

      p.log('----send toggle skipfile status request----');
      await p.dap.toggleSkipFileStatus({ resource: path });
      await p.logger.logStackTrace(event.threadId!, false);

      p.log('----send (un)toggle skipfile status request----');
      await p.dap.toggleSkipFileStatus({ resource: path });
      await p.logger.logStackTrace(event.threadId!, false);

      p.assertLog();
    });
  });
});
