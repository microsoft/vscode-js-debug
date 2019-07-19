/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {TestP} from '../test';

export function addTests(testRunner) {
  // @ts-ignore unused variables xit/fit.
  const {it, xit, fit} = testRunner;

  it('pausedFromInitialScript', async({p} : {p: TestP}) => {
    p.launch('<script>debugger;</script>');
    const event = await p.dap.once('stopped');
    p.log(event);
    p.log(await p.dap.stackTrace({threadId: event.threadId!}));
    p.log(await p.dap.continue({threadId: event.threadId!}));
    p.assertLog();
  });

  it('pausedFromEval', async({p}: {p: TestP}) => {
    await p.launchAndLoad('blank');
    p.cdp.Runtime.evaluate({expression: '\n\ndebugger;\n//# sourceURL=eval.js'});
    const event = p.log(await p.dap.once('stopped'));
    p.log(await p.dap.stackTrace({threadId: event.threadId}));
    p.log(await p.dap.continue({threadId: event.threadId}));
    p.assertLog();
  });

  it('pauseOnExceptions', async({p}: {p: TestP}) => {
    async function waitForPauseOnException() {
      const event = p.log(await p.dap.once('stopped'));
      p.log(await p.dap.exceptionInfo({threadId: event.threadId}));
      p.log(await p.dap.continue({threadId: event.threadId}));
    }

    await p.launchAndLoad('blank');

    p.log('Not pausing on exceptions');
    await p.dap.setExceptionBreakpoints({filters: []});
    await p.evaluate(`setTimeout(() => { throw new Error('hello'); })`);
    await p.evaluate(`setTimeout(() => { try { throw new Error('hello'); } catch (e) {}})`);

    p.log('Pausing on uncaught exceptions');
    await p.dap.setExceptionBreakpoints({filters: ['uncaught']});
    await p.evaluate(`setTimeout(() => { try { throw new Error('hello'); } catch (e) {}})`);
    p.evaluate(`setTimeout(() => { throw new Error('hello'); })`);
    await waitForPauseOnException();

    p.log('Pausing on caught exceptions');
    await p.dap.setExceptionBreakpoints({filters: ['caught']});
    p.evaluate(`setTimeout(() => { throw new Error('hello'); })`);
    await waitForPauseOnException();
    p.evaluate(`setTimeout(() => { try { throw new Error('hello'); } catch (e) {}})`);
    await waitForPauseOnException();
    p.assertLog();
  });

  it('pauseOnInnerHtml', async({p}: {p: TestP}) => {
    await p.launchAndLoad('<div>text</div>');

    p.log('Not pausing on innerHTML');
    await p.evaluate(`document.querySelector('div').innerHTML = 'foo';`);

    p.log('Pausing on innerHTML');
    await p.adapter.threadManager.enableCustomBreakpoints(['instrumentation:Element.setInnerHTML']);
    p.evaluate(`document.querySelector('div').innerHTML = 'bar';`);
    const event = p.log(await p.dap.once('stopped'));
    p.log(await p.dap.continue({threadId: event.threadId}));
    p.assertLog();
  });
}
