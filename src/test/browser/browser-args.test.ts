/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { BrowserArgs } from '../../targets/browser/browserArgs';
import { expect } from 'chai';

describe('BrowserArgs', () => {
  it('merge', () => {
    const actual = new BrowserArgs(['--a', '--b=foo']).merge(['--b=bar', '--c']);
    expect(actual.toArray()).to.deep.equal(['--a', '--b=bar', '--c']);
  });

  it('add', () => {
    const actual = new BrowserArgs(['--a', '--b=foo']).add('--a').add('--b', 'bar').add('--c');
    expect(actual.toArray()).to.deep.equal(['--a', '--b=bar', '--c']);
  });

  it('remove', () => {
    const actual = new BrowserArgs(['--a', '--b=foo']).remove('--b');
    expect(actual.toArray()).to.deep.equal(['--a']);
  });

  it('getSuggestedConnection', () => {
    expect(new BrowserArgs(['--a', '--b=foo']).getSuggestedConnection()).to.be.undefined;
    expect(
      new BrowserArgs(['--a', '--remote-debugging-port=42']).getSuggestedConnection(),
    ).to.equal(42);
    expect(new BrowserArgs(['--a', '--remote-debugging-pipe']).getSuggestedConnection()).to.equal(
      'pipe',
    );
  });

  it('setConnection', () => {
    const original = new BrowserArgs([
      '--a',
      '--remote-debugging-port=42',
      '--remote-debugging-pipe',
    ]);
    expect(original.setConnection('pipe').toArray()).to.deep.equal([
      '--a',
      '--remote-debugging-pipe',
    ]);
    expect(original.setConnection(1337).toArray()).to.deep.equal([
      '--a',
      '--remote-debugging-port=1337',
    ]);
  });

  it('filter', () => {
    const actual = new BrowserArgs(['--a', '--b=42', '--c=44']).filter(
      (k, v) => k === '--b' || v === '44',
    );
    expect(actual.toArray()).to.deep.equal(['--b=42', '--c=44']);
  });
});
