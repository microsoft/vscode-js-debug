// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {TestP} from '../test';

export function addTests(testRunner) {
  // @ts-ignore unused variables xit/fit.
  const {it, xit, fit} = testRunner;

  async function dumpStackAndContinue(p: TestP, scopes: boolean) {
    const event = await p.dap.once('stopped');
    await p.logger.logStackTrace(event.threadId!, scopes);
    await p.dap.continue({threadId: event.threadId!});
  }

  it('eval in anonymous', async({p}: {p: TestP}) => {
    await p.launchAndLoad('blank');
    p.cdp.Runtime.evaluate({expression: '\n\ndebugger;\n//# sourceURL=eval.js'});
    await dumpStackAndContinue(p, false);
    p.assertLog();
  });

  it('anonymous initial script', async({p}: {p: TestP}) => {
    p.launch('<script>debugger;</script>');
    await dumpStackAndContinue(p, false);
    p.assertLog();
  });

  it('anonymous scopes', async({p}: {p: TestP}) => {
    await p.launchAndLoad('blank');
    p.cdp.Runtime.evaluate({expression: `
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
    `});
    await dumpStackAndContinue(p, true);
    p.assertLog();
  });

  it('async', async({p}: {p: TestP}) => {
    await p.launchAndLoad('blank');
    p.cdp.Runtime.evaluate({expression: `
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
    `});
    await dumpStackAndContinue(p, true);
    p.assertLog();
  });

  it('cross target', async({p}: {p: TestP}) => {
    await p.launchUrl('worker.html');
    p.cdp.Runtime.evaluate({expression: `window.w.postMessage('pause')`});
    await dumpStackAndContinue(p, true);
    p.assertLog();
  });

  it('source map', async({p}: {p: TestP}) => {
    await p.launchUrl('index.html');
    p.addScriptTag('browserify/pause.js');
    await dumpStackAndContinue(p, true);
    p.assertLog();
  });

  it('blackboxed', async({p}: {p: TestP}) => {
    p.setBlackboxPattern('^(.*/node_modules/.*|.*module2.ts)$');
    await p.launchUrl('index.html');
    p.addScriptTag('browserify/pause.js');
    await dumpStackAndContinue(p, false);
    p.assertLog();
  });

  it('return value', async({p}: {p: TestP}) => {
    await p.launchAndLoad('blank');
    p.cdp.Runtime.evaluate({expression: `
      function foo() {
        debugger;
        return 42;
      }
      foo();
    `});
    const {threadId} = await p.dap.once('stopped');  // debugger
    p.dap.next({threadId: threadId!});
    await p.dap.once('stopped');  // return 42
    p.dap.next({threadId: threadId!});
    await dumpStackAndContinue(p, true);  // exit point
    p.assertLog();
  });
}
