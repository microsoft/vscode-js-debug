/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { SourceMapOverrides } from '../../targets/sourceMapOverrides';
import { baseDefaults } from '../../configuration';

describe('SourceMapOverrides', () => {
  describe('functionality', () => {
    it('replaces simple paths', () => {
      const r = new SourceMapOverrides({ '/a/*': '/b/*' });
      expect(r.apply('/a/foo/bar')).to.equal('/b/foo/bar');
      expect(r.apply('/q/foo/bar')).to.equal('/q/foo/bar');
    });

    it('replaces paths without groups on the right', () => {
      const r = new SourceMapOverrides({ '/a/*': '/b' });
      expect(r.apply('/a/foo/bar')).to.equal('/b');
    });

    it('replaces paths without groups on the left or right', () => {
      const r = new SourceMapOverrides({ '/a': '/b' });
      expect(r.apply('/a/foo/bar')).to.equal('/a/foo/bar');
      expect(r.apply('/a')).to.equal('/b');
    });

    it('handles non-capturing groups', () => {
      const r = new SourceMapOverrides({ '/a/?:*/*': '/b/*' });
      expect(r.apply('/a/foo/bar')).to.equal('/b/bar');
    });

    it('applies longer replacements first', () => {
      const r = new SourceMapOverrides({ '/a/*': '/c', '/a/foo': '/b' });
      expect(r.apply('/a/foo')).to.equal('/b');
    });
  });

  describe('defaults', () => {
    const r = new SourceMapOverrides(baseDefaults.sourceMapPathOverrides);

    it('does not touch already valid paths', () => {
      expect(r.apply('https://contoso.com/foo.ts')).to.equal('https://contoso.com/foo.ts');
      expect(r.apply('file:///dev/foo.ts')).to.equal('file:///dev/foo.ts');
    });

    it('resolves webpack paths', () => {
      expect(r.apply('webpack:///src/index.ts')).to.equal('src/index.ts');
    });

    it('replaces webpack namespaces', () => {
      expect(r.apply('webpack://lib/src/index.ts')).to.equal('src/index.ts');
    });
  });
});
