/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { EnvironmentVars } from '../../common/environmentVars';
import { expect } from 'chai';

describe('EnvironmentVars', () => {
  const vars = new EnvironmentVars({
    undef: undefined,
    null: null,
    foo: 'bar',
  });

  it('looks up properties', () => {
    expect(vars.lookup('foo')).to.equal('bar');
    expect(vars.lookup('wut')).to.be.undefined;
    expect(vars.lookup('null')).to.be.null;
  });

  it('merges', () => {
    expect(vars.merge({ foo: 'updated', bar: 'baz' }).value).to.deep.equal({
      null: null,
      foo: 'updated',
      bar: 'baz',
    });
  });

  describe('posix', () => {
    before(() => {
      EnvironmentVars.platform = 'linux';
    });

    after(() => {
      EnvironmentVars.platform = process.platform;
    });

    it('looks up case sensitive', () => {
      expect(vars.lookup('foo')).to.equal('bar');
      expect(vars.lookup('FOO')).to.be.undefined;
    });

    it('updates case sensitive', () => {
      const updated = vars.update('fOO', 'updated');
      expect(updated.value.foo).to.equal('bar');
      expect(updated.value.fOO).to.equal('updated');
    });

    it('creates a new path', () => {
      expect(vars.addToPath('/usr/bin').value).to.containSubset({ PATH: '/usr/bin' });
    });

    it('adds to an existing path ', () => {
      expect(vars.addToPath('/usr/local/bin').addToPath('/usr/bin').value).to.containSubset({
        PATH: '/usr/local/bin:/usr/bin',
      });
    });
  });

  describe('win32', () => {
    before(() => {
      EnvironmentVars.platform = 'win32';
    });

    after(() => {
      EnvironmentVars.platform = process.platform;
    });

    it('looks up case insensitive', () => {
      expect(vars.lookup('FOO')).to.equal('bar');
      expect(vars.lookup('foo')).to.equal('bar');
    });

    it('updates case insensitive', () => {
      const updated = vars.update('fOO', 'updated');
      expect(updated.value.foo).to.equal('updated');
      expect(updated.value.fOO).to.be.undefined;
    });

    it('creates a new path', () => {
      expect(vars.addToPath('C:\\bin').value).to.containSubset({ Path: 'C:\\bin' });
    });

    it('adds to an existing path ', () => {
      expect(vars.update('path', 'C:\\Python').addToPath('C:\\bin').value).to.containSubset({
        path: 'C:\\Python;C:\\bin',
      });
    });
  });
});
