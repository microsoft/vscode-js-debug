// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { TestP } from '../test';
import { itIntegrates } from '../testIntegrationUtils';

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

  itIntegrates('blackboxed', async ({ r }) => {
    r.setBlackboxPattern('^(.*/node_modules/.*|.*module2.ts)$');
    const p = await r.launchUrlAndLoad('index.html');
    p.addScriptTag('browserify/pause.js');
    await dumpStackAndContinue(p, false);
    p.assertLog();
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
});
