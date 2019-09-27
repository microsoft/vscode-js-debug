// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { TestRoot } from '../test';

export function addTests(testRunner) {
  // @ts-ignore unused xit/fit variables.
  const {it, fit, xit} = testRunner;

  it('initialize', async({r} : {r: TestRoot}) => {
    r.log(await r.initialize);
    r.assertLog();
  });
}

