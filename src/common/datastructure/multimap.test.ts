/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { MultiMap } from './multimap';

describe('multimap', () => {
  interface IRecord {
    a: number;
    b: string;
  }

  let mm: MultiMap<IRecord, { a: number; b: string }>;

  beforeEach(() => {
    mm = new MultiMap({
      a: v => v.a,
      b: v => v.b,
    });
  });

  it('stores and looks up records', () => {
    const a: IRecord = { a: 1, b: 'foo' };
    const b: IRecord = { a: 3, b: 'bar' };

    mm.add(a);
    mm.add(b);

    expect(mm.has('a', 1)).to.be.true;
    expect(mm.has('a', 2)).to.be.false;

    expect(mm.get('a', 1)).to.equal(a);
    expect(mm.get('a', 2)).to.be.undefined;
    expect(mm.get('a', 3)).to.equal(b);

    expect(mm.get('b', 'foo')).to.equal(a);
    expect(mm.get('b', 'boop')).to.be.undefined;
    expect(mm.get('b', 'bar')).to.equal(b);
  });

  it('deletes', () => {
    const a: IRecord = { a: 1, b: 'foo' };
    const b: IRecord = { a: 3, b: 'foo' };

    mm.add(a);
    mm.add(b);

    mm.delete(a);

    expect(mm.get('a', 3)).to.equal(b);
    expect(mm.get('a', 1)).to.be.undefined;
    expect(mm.get('b', 'foo')).to.equal(b);
  });

  it('lists entries', () => {
    const a: IRecord = { a: 1, b: 'foo' };
    const b: IRecord = { a: 3, b: 'bar' };

    mm.add(a);
    mm.add(b);

    expect([...mm]).to.deep.equal([a, b]);
  });

  it('clears', () => {
    mm.add({ a: 1, b: 'foo' });
    mm.add({ a: 3, b: 'bar' });
    mm.clear();
    expect([...mm]).to.be.empty;
  });
});
