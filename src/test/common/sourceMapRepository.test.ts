/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { join } from 'path';
import { FileGlobList } from '../../common/fileGlobList';
import { Logger } from '../../common/logging/logger';
import { fixDriveLetter, fixDriveLetterAndSlashes } from '../../common/pathUtils';
import { ISearchStrategy } from '../../common/sourceMaps/sourceMapRepository';
import { TurboSearchStrategy } from '../../common/sourceMaps/turboSearchStrategy';
import { absolutePathToFileUrl } from '../../common/urlUtils';
import { createFileTree } from '../createFileTree';
import { testFixturesDir, testFixturesDirName, workspaceFolder } from '../test';

describe('ISourceMapRepository', () => {
  [{ name: 'TurboSearchStrategy', create: () => new TurboSearchStrategy(Logger.null) }].forEach(
    tcase =>
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

        const gatherSm = async (list: FileGlobList) => {
          type TReturn = {
            sourceMapUrl: string;
            compiledPath: string;
          };
          const result = await r.streamChildrenWithSourcemaps<TReturn, TReturn>({
            files: list,
            processMap: async m => {
              const { cacheKey, ...rest } = m;
              expect(cacheKey).to.be.within(Date.now() - 60 * 1000, Date.now() + 1000);
              rest.compiledPath = fixDriveLetterAndSlashes(rest.compiledPath);
              return rest;
            },
            onProcessedMap: r => r,
          });
          return result.values.sort((a, b) => a.compiledPath.length - b.compiledPath.length);
        };
        const gatherSmNames = async (list: FileGlobList) => {
          const result = await gatherSm(list);
          return result.map(r => fixDriveLetterAndSlashes(r.compiledPath));
        };

        const gatherAll = (list: FileGlobList) => {
          return r.streamAllChildren(list, m => m).then(r => r.sort());
        };

        it('no-ops for non-existent directories', async () => {
          expect(await gatherSm(gatherFileList(__dirname, 'does-not-exist'))).to.be.empty;
        });

        it('discovers source maps and applies negated globs', async () => {
          expect(
            await gatherSm(gatherFileList(workspaceFolder, testFixturesDirName)),
          ).to.deep.equal([
            {
              compiledPath: fixDriveLetter(join(testFixturesDir, 'a.js')),
              sourceMapUrl: absolutePathToFileUrl(join(testFixturesDir, 'a.js.map')),
            },
            {
              compiledPath: fixDriveLetter(join(testFixturesDir, 'nested', 'd.js')),
              sourceMapUrl: absolutePathToFileUrl(join(testFixturesDir, 'nested', 'd.js.map')),
            },
            {
              compiledPath: fixDriveLetter(
                join(testFixturesDir, 'defaultSearchExcluded', 'f.js'),
              ),
              sourceMapUrl: absolutePathToFileUrl(
                join(testFixturesDir, 'defaultSearchExcluded', 'f.js.map'),
              ),
            },
          ]);
        });

        it('applies second patterns (vscode#168635)', async () => {
          createFileTree(testFixturesDir, {
            rootPath: {
              'd.js': '//# sourceMappingURL=d.js.map',
              'd.js.map': 'content2',
            },
            otherFolder: {
              'f.js': '//# sourceMappingURL=f.js.map',
              'f.js.map': 'content3',
            },
          });

          expect(
            await gatherSmNames(
              new FileGlobList({
                patterns: ['rootPath/*.js', 'otherFolder/*.js'],
                rootPath: testFixturesDir,
              }),
            ),
          ).to.deep.equal([
            fixDriveLetter(join(testFixturesDir, 'rootPath', 'd.js')),
            fixDriveLetter(join(testFixturesDir, 'otherFolder', 'f.js')),
          ]);
        });

        it('globs for a single file', async () => {
          expect(
            await gatherSmNames(
              new FileGlobList({
                patterns: ['nested/d.js'],
                rootPath: testFixturesDir,
              }),
            ),
          ).to.deep.equal([fixDriveLetter(join(testFixturesDir, 'nested', 'd.js'))]);
        });

        it('applies negated globs outside rootPath (#1479)', async () => {
          // also tests https://github.com/microsoft/vscode/issues/104889#issuecomment-993722692
          const nodeModules = {
            'e.js': '//# sourceMappingURL=e.js.map',
            'e.js.map': 'content3',
          };
          createFileTree(testFixturesDir, {
            rootPath: {
              'd.js': '//# sourceMappingURL=d.js.map',
              'd.js.map': 'content2',
              node_modules: nodeModules,
            },
            otherFolder: {
              'f.js': '//# sourceMappingURL=f.js.map',
              'f.js.map': 'content3',
              node_modules: nodeModules,
            },
          });

          expect(
            await gatherSmNames(
              new FileGlobList({
                patterns: ['**/*.js', '../otherFolder/**/*.js', '!**/node_modules/**'],
                rootPath: join(testFixturesDir, 'rootPath'),
              }),
            ),
          ).to.deep.equal([
            fixDriveLetter(join(testFixturesDir, 'rootPath', 'd.js')),
            fixDriveLetter(join(testFixturesDir, 'otherFolder', 'f.js')),
          ]);
        });

        it('streams all children', async () => {
          expect(
            await gatherAll(gatherFileList(workspaceFolder, testFixturesDirName)),
          ).to.deep.equal([
            fixDriveLetter(join(testFixturesDir, 'a.js')),
            fixDriveLetter(join(testFixturesDir, 'c.js')),
            fixDriveLetter(join(testFixturesDir, 'defaultSearchExcluded', 'f.js')),
            fixDriveLetter(join(testFixturesDir, 'nested', 'd.js')),
          ]);
        });

        it('greps inside node_modules explicitly', async () => {
          expect(
            await gatherSm(gatherFileList(join(testFixturesDir, 'node_modules'), '.')),
          ).to.deep.equal([
            {
              compiledPath: fixDriveLetter(join(testFixturesDir, 'node_modules', 'e.js')),
              sourceMapUrl: absolutePathToFileUrl(
                join(testFixturesDir, 'node_modules', 'e.js.map'),
              ),
            },
          ]);
        });
      }),
  );
});
