/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import {
  ISourceMapRepository,
  IRelativePattern,
} from '../../common/sourceMaps/sourceMapRepository';
import { join } from 'path';
import { createFileTree, testFixturesDir, workspaceFolder, testFixturesDirName } from '../test';
import { absolutePathToFileUrl } from '../../common/urlUtils';
import { NodeSourceMapRepository } from '../../common/sourceMaps/nodeSourceMapRepository';
import * as vscode from 'vscode';
import { CodeSearchSourceMapRepository } from '../../common/sourceMaps/codeSearchSourceMapRepository';
import { fixDriveLetter } from '../../common/pathUtils';

describe('ISourceMapRepository', () => {
  [
    { name: 'NodeSourceMapRepository', create: () => new NodeSourceMapRepository() },
    {
      name: 'CodeSearchSourceMapRepository',
      create: () =>
        new CodeSearchSourceMapRepository(vscode.workspace.findTextInFiles.bind(vscode.workspace)),
    },
  ].forEach(tcase =>
    describe(tcase.name, () => {
      let r: ISourceMapRepository;
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
        });
      });

      const gather = (dir: string, firstIncludeSegment: string) => {
        const patterns: IRelativePattern[] = [
          `${firstIncludeSegment}/**/*.js`,
          '!**/node_modules/**',
        ].map(p => ({
          base: dir,
          pattern: p,
        }));
        return r
          .streamAllChildren(patterns, async m => {
            const { mtime, ...rest } = m;
            expect(mtime).to.be.within(Date.now() - 60 * 1000, Date.now() + 1000);
            rest.compiledPath = fixDriveLetter(rest.compiledPath);
            return rest;
          })
          .then(r => r.sort((a, b) => a.compiledPath.length - b.compiledPath.length));
      };

      it('no-ops for non-existent directories', async () => {
        expect(await gather(__dirname, 'does-not-exist')).to.be.empty;
      });

      it('discovers all children and applies negated globs', async () => {
        expect(await gather(workspaceFolder, testFixturesDirName)).to.deep.equal([
          {
            compiledPath: fixDriveLetter(join(testFixturesDir, 'a.js')),
            sourceMapUrl: absolutePathToFileUrl(join(testFixturesDir, 'a.js.map')),
          },
          {
            compiledPath: fixDriveLetter(join(testFixturesDir, 'nested', 'd.js')),
            sourceMapUrl: absolutePathToFileUrl(join(testFixturesDir, 'nested', 'd.js.map')),
          },
        ]);
      });
    }),
  );
});
