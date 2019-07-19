// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {TestP} from '../test';

export function addTests(testRunner) {
  // @ts-ignore unused variables xit/fit.
  const {it, xit, fit} = testRunner;

  async function waitForPauseOnException(p: TestP) {
    const event = p.log(await p.dap.once('stopped'));
    p.log(await p.dap.exceptionInfo({threadId: event.threadId}));
    p.log(await p.dap.continue({threadId: event.threadId}));
  }

  it('pauseOnExceptions', async({p}: {p: TestP}) => {
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

  it('pause on exceptions configuration', async({p}: {p: TestP}) => {
    await p.initialize;
    await p.dap.setExceptionBreakpoints({filters: ['uncaught']});
    p.launch(`
      <script>
        try {
          throw new Error('this is a caught error');
        } catch (e) {
        }
        throw new Error('this is an uncaught error');
      </script>
    `);
    await waitForPauseOnException(p);
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
