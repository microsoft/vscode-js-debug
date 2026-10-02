/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { Base0Position } from './positions';
import { PositionToOffset, trimEnd } from './stringUtils';

describe('stringUtils', () => {
  it('trimEnd does not split surrogate pairs', () => {
    expect(trimEnd('ab\u{1F600}cd', 4)).to.equal('ab…');
    expect(trimEnd('ab\u{1F600}cd', 5)).to.equal('ab\u{1F600}…');
  });

  it('positionToOffset', () => {
    const simple = new PositionToOffset('hello\nworld');
    expect(simple.convert(new Base0Position(0, 2))).to.equal(2);
    expect(simple.convert(new Base0Position(1, 2))).to.equal(8);

    const toOffset = new PositionToOffset('\nhello\nworld\n');

    expect(toOffset.convert(new Base0Position(0, 0))).to.equal(0);
    expect(toOffset.convert(new Base0Position(0, 10))).to.equal(0);

    expect(toOffset.convert(new Base0Position(1, 0))).to.equal(1);
    expect(toOffset.convert(new Base0Position(1, 5))).to.equal(6);
    expect(toOffset.convert(new Base0Position(2, 1))).to.equal(8);

    expect(toOffset.convert(new Base0Position(3, 0))).to.equal(13);
    expect(toOffset.convert(new Base0Position(10, 0))).to.equal(13);
  });
});
