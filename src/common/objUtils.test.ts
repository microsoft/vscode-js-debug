/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { memoizeLast } from './objUtils';

describe('objUtils', () => {
  it('memoizeLast', () => {
    let calls = 0;
    const fn = memoizeLast((m: number[]) => {
      calls++;
      return m.reduce((a, b) => a + b, 0);
    });

    const a = [1, 2, 3];
    const b = [4, 5, 6];
    expect(fn(a)).to.equal(6);
    expect(calls).to.equal(1);

    expect(fn(a)).to.equal(6);
    expect(calls).to.equal(1);

    expect(fn(b)).to.equal(15);
    expect(calls).to.equal(2);

    expect(fn(b)).to.equal(15);
    expect(calls).to.equal(2);

    expect(fn(a)).to.equal(6);
    expect(calls).to.equal(3);
  });
});
