// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { TestP } from '../test';

export function addTests(testRunner) {
  // @ts-ignore unused xit/fit variables.
  const {it, fit, xit} = testRunner;

  it('initialize', async({p} : {p: TestP}) => {
    p.log(await p.initialize);
    p.assertLog();
  });
}

