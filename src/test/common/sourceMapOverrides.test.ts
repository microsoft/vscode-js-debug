/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import * as path from 'path';
import { Logger } from '../../common/logging/logger';
import { fixDriveLetter } from '../../common/pathUtils';
import {
  defaultPathMappingResolver,
  getComputedSourceRoot,
} from '../../common/sourceMaps/sourceMapResolutionUtils';

describe('SourceMapOverrides', () => {
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
          Logger.null,
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
          Logger.null,
        ),
      ).to.equal(resolve('/project/webroot/src'));
    });

    it('handles /src style without matching pathMapping', async () => {
      expect(
        await getComputedSourceRoot(
          '/foo/bar',
          genPath,
          {},
          defaultPathMappingResolver,
          Logger.null,
        ),
      ).to.equal('/foo/bar');
    });

    it('handles c:/src style without matching pathMapping', async () => {
      expect(
        await getComputedSourceRoot(
          'c:\\foo\\bar',
          genPath,
          {},
          defaultPathMappingResolver,
          Logger.null,
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
          Logger.null,
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
          Logger.null,
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
          Logger.null,
        ),
      ).to.equal(resolve('/project/webroot/src'));
    });

    it('when no sourceRoot specified and runtime script is on disk, uses the runtime script dirname', async () => {
      expect(
        await getComputedSourceRoot(
          '',
          genPath,
          PATH_MAPPING,
          defaultPathMappingResolver,
          Logger.null,
        ),
      ).to.equal(resolve('/project/webroot/code'));
    });

    it('when no sourceRoot specified and runtime script is not on disk, uses the runtime script dirname', async () => {
      expect(
        await getComputedSourceRoot(
          '',
          GEN_URL,
          PATH_MAPPING,
          defaultPathMappingResolver,
          Logger.null,
        ),
      ).to.equal(resolve('/project/webroot/code'));
    });

    it('no crash on debugadapter:// urls', async () => {
      expect(
        await getComputedSourceRoot(
          '',
          'eval://123',
          PATH_MAPPING,
          defaultPathMappingResolver,
          Logger.null,
        ),
      ).to.equal(resolve(WEBROOT));
    });
  });
});
