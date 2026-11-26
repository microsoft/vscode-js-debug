/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { memoizeLast, posInt32Counter } from './objUtils';

describe('objUtils', () => {
  it('posInt32Counter', () => {
    const counter = posInt32Counter();
    expect(counter()).to.equal(0);
    expect(counter()).to.equal(1);

    counter.skipPast(5);
    expect(counter()).to.equal(6);

    // never moves backwards
    counter.skipPast(2);
    expect(counter()).to.equal(7);
  });

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
