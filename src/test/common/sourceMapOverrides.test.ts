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
import { ILogger } from '../../common/logging';
import { Logger } from '../../common/logging/logger';

describe('SourceMapOverrides', () => {
  let logger: ILogger;
  before(async () => (logger = await Logger.test()));

  describe('functionality', () => {
    it('replaces simple paths', () => {
      const r = new SourceMapOverrides({ '/a/*': '/b/*' }, logger);
      expect(r.apply('/a/foo/bar')).to.equal('/b/foo/bar');
      expect(r.apply('/q/foo/bar')).to.equal('/q/foo/bar');
    });

    it('replaces paths without groups on the right', () => {
      const r = new SourceMapOverrides({ '/a/*': '/b' }, logger);
      expect(r.apply('/a/foo/bar')).to.equal('/b');
    });

    it('replaces paths without groups on the left or right', () => {
      const r = new SourceMapOverrides({ '/a': '/b' }, logger);
      expect(r.apply('/a/foo/bar')).to.equal('/a/foo/bar');
      expect(r.apply('/a')).to.equal('/b');
    });

    it('handles non-capturing groups', () => {
      const r = new SourceMapOverrides({ '/a/?:*/*': '/b/*' }, logger);
      expect(r.apply('/a/foo/bar')).to.equal('/b/bar');
    });

    it('applies longer replacements first', () => {
      const r = new SourceMapOverrides({ '/a/*': '/c', '/a/foo': '/b' }, logger);
      expect(r.apply('/a/foo')).to.equal('/b');
    });

    it('normalizes slashes in returned paths (issue #401)', () => {
      const r = new SourceMapOverrides(
        {
          'webpack:/*': '${webRoot}/*',
          '/./*': '${webRoot}/*',
          '/src/*': '${webRoot}/*',
          '/*': '*',
          '/./~/*': '${webRoot}/node_modules/*',
        },
        logger,
      );

      expect(r.apply('webpack:///src/app/app.component.ts')).to.equal(
        path.join('${webRoot}/src/app/app.component.ts'),
      );
    });

    it('handles meteor paths (issue #491)', () => {
      const r = new SourceMapOverrides(
        {
          'meteor:/💻app/*': '${webRoot}/*',
          'meteor://💻app/*': '${webRoot}/*',
          '~/dev/booker-meteor/meteor:/💻app/*': '${webRoot}/*',
          'packages/meteor:/💻app/*': '${workspaceFolder}/.meteor/packages/*',
        },
        logger,
      );

      expect(r.apply('meteor://💻app/packages/base64/base64.js')).to.equal(
        path.join('${webRoot}/packages/base64/base64.js'),
      );
    });
  });

  describe('defaults', () => {
    let r: SourceMapOverrides;
    before(() => (r = new SourceMapOverrides(baseDefaults.sourceMapPathOverrides, logger)));

    it('does not touch already valid paths', () => {
      expect(r.apply('https://contoso.com/foo.ts')).to.equal('https://contoso.com/foo.ts');
      expect(r.apply('file:///dev/foo.ts')).to.equal('file:///dev/foo.ts');
    });

    it('resolves webpack paths', () => {
      expect(r.apply('webpack:///src/index.ts')).to.equal(
        path.join('${workspaceFolder}/src/index.ts'),
      );
    });

    it('replaces webpack namespaces', () => {
      expect(r.apply('webpack://lib/src/index.ts')).to.equal(
        path.join('${workspaceFolder}/src/index.ts'),
      );
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
          logger,
        ),
      ).to.equal(ABS_SOURCEROOT);
    });

    it('handles /src style sourceRoot', async () => {
      expect(
        await getComputedSourceRoot(
          '/src',
          genPath,
          PATH_MAPPING,
          defaultPathMappingResolver,
          logger,
        ),
      ).to.equal(resolve('/project/webroot/src'));
    });

    it('handles /src style without matching pathMapping', async () => {
      expect(
        await getComputedSourceRoot('/foo/bar', genPath, {}, defaultPathMappingResolver, logger),
      ).to.equal('/foo/bar');
    });

    it('handles c:/src style without matching pathMapping', async () => {
      expect(
        await getComputedSourceRoot(
          'c:\\foo\\bar',
          genPath,
          {},
          defaultPathMappingResolver,
          logger,
        ),
      ).to.equal('c:\\foo\\bar');
    });

    it('handles ../../src style sourceRoot', async () => {
      expect(
        await getComputedSourceRoot(
          '../../src',
          genPath,
          PATH_MAPPING,
          defaultPathMappingResolver,
          logger,
        ),
      ).to.equal(ABS_SOURCEROOT);
    });

    it('handles src style sourceRoot', async () => {
      expect(
        await getComputedSourceRoot(
          'src',
          genPath,
          PATH_MAPPING,
          defaultPathMappingResolver,
          logger,
        ),
      ).to.equal(resolve('/project/webroot/code/src'));
    });

    it('handles runtime script not on disk', async () => {
      expect(
        await getComputedSourceRoot(
          '../src',
          GEN_URL,
          PATH_MAPPING,
          defaultPathMappingResolver,
          logger,
        ),
      ).to.equal(resolve('/project/webroot/src'));
    });

    it('when no sourceRoot specified and runtime script is on disk, uses the runtime script dirname', async () => {
      expect(
        await getComputedSourceRoot('', genPath, PATH_MAPPING, defaultPathMappingResolver, logger),
      ).to.equal(resolve('/project/webroot/code'));
    });

    it('when no sourceRoot specified and runtime script is not on disk, uses the runtime script dirname', async () => {
      expect(
        await getComputedSourceRoot('', GEN_URL, PATH_MAPPING, defaultPathMappingResolver, logger),
      ).to.equal(resolve('/project/webroot/code'));
    });

    it('no crash on debugadapter:// urls', async () => {
      expect(
        await getComputedSourceRoot(
          '',
          'eval://123',
          PATH_MAPPING,
          defaultPathMappingResolver,
          logger,
        ),
      ).to.equal(resolve(WEBROOT));
    });
  });
});
