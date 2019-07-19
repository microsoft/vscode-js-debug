// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {TestP} from '../test';

export function addTests(testRunner) {
  // @ts-ignore unused variables xit/fit.
  const {it, xit, fit} = testRunner;

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
