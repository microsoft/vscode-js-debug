/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import del from 'del';
import { mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as vscode from 'vscode';
import { fixDriveLetter } from '../../common/pathUtils';
import { CodeSearchSourceMapRepository } from '../../common/sourceMaps/codeSearchSourceMapRepository';
import { NodeSourceMapRepository } from '../../common/sourceMaps/nodeSourceMapRepository';
import { ISourceMapRepository } from '../../common/sourceMaps/sourceMapRepository';
import { absolutePathToFileUrl } from '../../common/urlUtils';
import { createFileTree, testFixturesDir, testFixturesDirName } from '../test';

describe('ISourceMapRepository', () => {
  let rgPath = join(tmpdir(), 'pwa-ripgrep');
  before(() => {
    try {
      mkdirSync(rgPath);
    } catch {
      // ignored
    }
  });

  after(() => del(`${rgPath}/**`, { force: true }));

  [
    {
      name: 'NodeSourceMapRepository',
      create: () => new NodeSourceMapRepository(),
      absolutePaths: true
    },
    {
      name: 'CodeSearchSourceMapRepository',
      create: () =>
        new CodeSearchSourceMapRepository(vscode.workspace.findTextInFiles.bind(vscode.workspace)),
      absolutePaths: false
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

      const gather = (dir: string) =>
        r
          .streamAllChildren([`${dir}/**/*.js`, '!**/node_modules/**'], async m => {
            const { mtime, ...rest } = m;
            expect(mtime).to.be.within(Date.now() - 60 * 1000, Date.now() + 1000);
            rest.compiledPath = fixDriveLetter(rest.compiledPath);
            return rest;
          })
          .then(r => r.sort((a, b) => a.compiledPath.length - b.compiledPath.length));

      it('no-ops for non-existent directories', async () => {
        const gatherPath = tcase.absolutePaths ? join(__dirname, 'does-not-exist') : 'does-not-exit';
        expect(await gather(gatherPath)).to.be.empty;
      });

      it('discovers all children and applies negated globs', async () => {
        const gatherPath = tcase.absolutePaths ? testFixturesDir : testFixturesDirName;
        expect(await gather(gatherPath)).to.deep.equal([
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
