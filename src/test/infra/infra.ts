/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as test from '../test';
import { GoldenText } from '../goldenText';

export function addStartupTests(testRunner) {
  // @ts-ignore unused xit/fit variables.
  const {it, fit, xit} = testRunner;

  it('initialize', async({goldenText} : {goldenText: GoldenText}) => {
    const p = new test.TestP(goldenText);
    p.dap.on('initialized', () => p.log('initialized'));
    p.log(await p.initialize);
    await p.disconnect();
    p.assertLog();
  });
}

