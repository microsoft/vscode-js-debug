/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { join } from 'path';
import { testFixturesDir, workspaceFolder, testFixturesDirName } from '../test';
import { createFileTree } from '../createFileTree';
import { absolutePathToFileUrl } from '../../common/urlUtils';
import * as vscode from 'vscode';
import { fixDriveLetter } from '../../common/pathUtils';
import { NodeSearchStrategy } from '../../common/sourceMaps/nodeSearchStrategy';
import { CodeSearchStrategy } from '../../common/sourceMaps/codeSearchStrategy';
import { Logger } from '../../common/logging/logger';
import { ISearchStrategy } from '../../common/sourceMaps/sourceMapRepository';
import { FileGlobList } from '../../common/fileGlobList';

describe('ISourceMapRepository', () => {
  [
    { name: 'NodeSourceMapRepository', create: () => new NodeSearchStrategy(Logger.null) },
    {
      name: 'CodeSearchSourceMapRepository',
      create: () => new CodeSearchStrategy(vscode, Logger.null),
    },
  ].forEach(tcase =>
    describe(tcase.name, () => {
      let r: ISearchStrategy;
      beforeEach(() => {
        r = tcase.create();
        createFileTree(testFixturesDir, {
          'a.js': '//# sourceMappingURL=a.js.map',
          'a.js.map': 'content1',
          'c.js': 'no.sourcemap.here',
          nested: {
            'd.js': '//# sourceMappingURL=d.js.map',
            'd.js.map': 'content2',
          },
          node_modules: {
            'e.js': '//# sourceMappingURL=e.js.map',
            'e.js.map': 'content3',
          },
          defaultSearchExcluded: {
            'f.js': '//# sourceMappingURL=f.js.map',
            'f.js.map': 'content3',
          },
        });
      });

      const gatherFileList = (rootPath: string, firstIncludeSegment: string) =>
        new FileGlobList({
          rootPath,
          patterns: [`${firstIncludeSegment}/**/*.js`, '!**/node_modules/**'],
        });

      const gatherSm = (rootPath: string, firstIncludeSegment: string) => {
        return r
          .streamChildrenWithSourcemaps(gatherFileList(rootPath, firstIncludeSegment), async m => {
            const { mtime, ...rest } = m;
            expect(mtime).to.be.within(Date.now() - 60 * 1000, Date.now() + 1000);
            rest.compiledPath = fixDriveLetter(rest.compiledPath);
            return rest;
          })
          .then(r => r.sort((a, b) => a.compiledPath.length - b.compiledPath.length));
      };

      const gatherAll = (rootPath: string, firstIncludeSegment: string) => {
        return r
          .streamAllChildren(gatherFileList(rootPath, firstIncludeSegment), m => m)
          .then(r => r.sort());
      };

      it('no-ops for non-existent directories', async () => {
        expect(await gatherSm(__dirname, 'does-not-exist')).to.be.empty;
      });

      it('discovers source maps and applies negated globs', async () => {
        expect(await gatherSm(workspaceFolder, testFixturesDirName)).to.deep.equal([
          {
            compiledPath: fixDriveLetter(join(testFixturesDir, 'a.js')),
            sourceMapUrl: absolutePathToFileUrl(join(testFixturesDir, 'a.js.map')),
          },
          {
            compiledPath: fixDriveLetter(join(testFixturesDir, 'nested', 'd.js')),
            sourceMapUrl: absolutePathToFileUrl(join(testFixturesDir, 'nested', 'd.js.map')),
          },
          {
            compiledPath: fixDriveLetter(join(testFixturesDir, 'defaultSearchExcluded', 'f.js')),
            sourceMapUrl: absolutePathToFileUrl(
              join(testFixturesDir, 'defaultSearchExcluded', 'f.js.map'),
            ),
          },
        ]);
      });

      it('streams all children', async () => {
        expect(await gatherAll(workspaceFolder, testFixturesDirName)).to.deep.equal([
          fixDriveLetter(join(testFixturesDir, 'a.js')),
          fixDriveLetter(join(testFixturesDir, 'c.js')),
          fixDriveLetter(join(testFixturesDir, 'defaultSearchExcluded', 'f.js')),
          fixDriveLetter(join(testFixturesDir, 'nested', 'd.js')),
        ]);
      });

      // todo: better absolute pathing support
      if (tcase.name !== 'CodeSearchSourceMapRepository') {
        it('greps inside node_modules explicitly', async () => {
          expect(await gatherSm(join(testFixturesDir, 'node_modules'), '.')).to.deep.equal([
            {
              compiledPath: fixDriveLetter(join(testFixturesDir, 'node_modules', 'e.js')),
              sourceMapUrl: absolutePathToFileUrl(
                join(testFixturesDir, 'node_modules', 'e.js.map'),
              ),
            },
          ]);
        });
      }
    }),
  );
});
