/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { SourceMapOverrides } from '../../targets/sourceMapOverrides';
import { baseDefaults } from '../../configuration';
import {
  getComputedSourceRoot,
  defaultPathMappingResolver,
} from '../../common/sourceMaps/sourceMapResolutionUtils';
import * as path from 'path';
import { fixDriveLetter } from '../../common/pathUtils';

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

    it('normalizes mapped paths', () => {
      const r = new SourceMapOverrides({ 'file:///./foo/*': '/b/*' });
      expect(r.apply('file:///foo/bar')).to.equal('/b/bar');
    });
  });

  describe('defaults', () => {
    const r = new SourceMapOverrides(baseDefaults.sourceMapPathOverrides);

    it('does not touch already valid paths', () => {
      expect(r.apply('https://contoso.com/foo.ts')).to.equal('https://contoso.com/foo.ts');
      expect(r.apply('file:///dev/foo.ts')).to.equal('file:///dev/foo.ts');
    });

    it('resolves webpack paths', () => {
      expect(r.apply('webpack:///src/index.ts')).to.equal('${workspaceFolder}/src/index.ts');
    });

    it('replaces webpack namespaces', () => {
      expect(r.apply('webpack://lib/src/index.ts')).to.equal('${workspaceFolder}/src/index.ts');
    });
  });

  describe('getComputedSourceRoot()', () => {
    const resolve = (...parts: string[]) => fixDriveLetter(path.resolve(...parts));
    const genPath = resolve('/project/webroot/code/script.js');
    const GEN_URL = 'http://localhost:8080/code/script.js';
    const ABS_SOURCEROOT = resolve('/project/src');
    const WEBROOT = resolve('/project/webroot');
    const PATH_MAPPING = { '/': WEBROOT };

    it('handles file:/// sourceRoot', async () => {
      expect(
        await getComputedSourceRoot(
          'file:///' + ABS_SOURCEROOT,
          genPath,
          PATH_MAPPING,
          defaultPathMappingResolver,
        ),
      ).to.equal(ABS_SOURCEROOT);
    });

    it('handles /src style sourceRoot', async () => {
      expect(
        await getComputedSourceRoot('/src', genPath, PATH_MAPPING, defaultPathMappingResolver),
      ).to.equal(resolve('/project/webroot/src'));
    });

    it('handles /src style without matching pathMapping', async () => {
      expect(
        await getComputedSourceRoot('/foo/bar', genPath, {}, defaultPathMappingResolver),
      ).to.equal('/foo/bar');
    });

    it('handles c:/src style without matching pathMapping', async () => {
      expect(
        await getComputedSourceRoot('c:\\foo\\bar', genPath, {}, defaultPathMappingResolver),
      ).to.equal('c:\\foo\\bar');
    });

    it('handles ../../src style sourceRoot', async () => {
      expect(
        await getComputedSourceRoot('../../src', genPath, PATH_MAPPING, defaultPathMappingResolver),
      ).to.equal(ABS_SOURCEROOT);
    });

    it('handles src style sourceRoot', async () => {
      expect(
        await getComputedSourceRoot('src', genPath, PATH_MAPPING, defaultPathMappingResolver),
      ).to.equal(resolve('/project/webroot/code/src'));
    });

    it('handles runtime script not on disk', async () => {
      expect(
        await getComputedSourceRoot('../src', GEN_URL, PATH_MAPPING, defaultPathMappingResolver),
      ).to.equal(resolve('/project/webroot/src'));
    });

    it('when no sourceRoot specified and runtime script is on disk, uses the runtime script dirname', async () => {
      expect(
        await getComputedSourceRoot('', genPath, PATH_MAPPING, defaultPathMappingResolver),
      ).to.equal(resolve('/project/webroot/code'));
    });

    it('when no sourceRoot specified and runtime script is not on disk, uses the runtime script dirname', async () => {
      expect(
        await getComputedSourceRoot('', GEN_URL, PATH_MAPPING, defaultPathMappingResolver),
      ).to.equal(resolve('/project/webroot/code'));
    });

    it('no crash on debugadapter:// urls', async () => {
      expect(
        await getComputedSourceRoot('', 'eval://123', PATH_MAPPING, defaultPathMappingResolver),
      ).to.equal(resolve(WEBROOT));
    });
  });
});
