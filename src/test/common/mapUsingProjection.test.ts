/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { MapUsingProjection } from '../../common/datastructure/mapUsingProjection';

describe('mapUsingProjection', () => {
  it('gets values', () => {
    const m: Map<string, number> = new MapUsingProjection(k => k.toLowerCase());
    m.set('bar', 1);
    expect(m.get('foo')).to.be.undefined;
    expect(m.get('bar')).to.equal(1);
    expect(m.get('bAr')).to.equal(1);
  });

  it('sets values', () => {
    const m: Map<string, number> = new MapUsingProjection(k => k.toLowerCase());
    m.set('bar', 1);
    expect(m.get('bar')).to.equal(1);
    m.set('BAR', 2);
    expect(m.get('bar')).to.equal(2);
  });

  it('deletes values', () => {
    const m: Map<string, number> = new MapUsingProjection(k => k.toLowerCase());
    m.set('bar', 1);
    m.delete('bAr');
    expect(m.get('bar')).to.be.undefined;
  });

  it('gets keys', () => {
    const m: Map<string, number> = new MapUsingProjection(k => k.toLowerCase());
    m.set('FOO', 1);
    m.set('bar', 1);
    expect([...m.keys()].sort()).to.deep.equal(['FOO', 'bar']);
  });

  it('gets values', () => {
    const m: Map<string, number> = new MapUsingProjection(k => k.toLowerCase());
    m.set('FOO', 1);
    m.set('bar', 2);
    expect([...m.values()].sort()).to.deep.equal([1, 2]);
  });
});
