/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { expect } from 'chai';
import { EnvironmentVars, getSanitizeProcessEnv } from './environmentVars';

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

  it('adds node options', () => {
    const v1 = vars.addNodeOption('--foo');
    const v2 = v1.addNodeOption('--bar');
    expect(v1.lookup('NODE_OPTIONS')).to.equal('--foo');
    expect(v2.lookup('NODE_OPTIONS')).to.equal('--foo --bar');
  });

  it('filters code vars from process', () => {
    const r = getSanitizeProcessEnv({
      ELECTRON_RUN_AS_NODE: '1',
      VSCODE_LOGS: 'logs.txt',
      APPLICATION_INSIGHTS_NO_DIAGNOSTIC_CHANNEL: '1',
      IS_COOL: 'very',
    });

    expect(r.defined()).to.deep.equal({ IS_COOL: 'very' });
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
      expect(vars.addToPath('/usr/bin', 'prepend', true).value).to.containSubset({
        PATH: '/usr/bin:${env:PATH}',
      });
      expect(vars.addToPath('/usr/bin', 'append', true).value).to.containSubset({
        PATH: '${env:PATH}:/usr/bin',
      });
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
      expect(vars.addToPath('C:\\bin', 'prepend', true).value).to.containSubset({
        Path: 'C:\\bin;${env:Path}',
      });
      expect(vars.addToPath('C:\\bin', 'append', true).value).to.containSubset({
        Path: '${env:Path};C:\\bin',
      });
    });

    it('adds to an existing path ', () => {
      expect(vars.update('path', 'C:\\Python').addToPath('C:\\bin').value).to.containSubset({
        path: 'C:\\Python;C:\\bin',
      });
    });
  });
});
