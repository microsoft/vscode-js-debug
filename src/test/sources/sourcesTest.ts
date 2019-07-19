/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {TestP} from '../test';

export function addTests(testRunner) {
  // @ts-ignore unused variables xit/fit.
  const {it, xit, fit} = testRunner;

  it('basic sources', async({p}: {p: TestP}) => {
    await p.launchUrl('index.html');
    p.addScriptTag('empty.js');
    p.log(await p.waitForSource('empty.js'), 'empty.js: ');
    p.evaluate('123', 'doesnotexist.js');
    p.log(await p.waitForSource('doesnotexist.js'), 'does not exist: ');
    p.addScriptTag('dir/helloworld.js');
    p.log(await p.waitForSource('helloworld.js'), 'dir/helloworld.js: ');
    p.evaluate('123', '');
    p.log(await p.waitForSource('eval'), 'eval: ');
    p.log(await p.dap.loadedSources({}), 'Loaded sources: ');
    p.assertLog();
  });
}
