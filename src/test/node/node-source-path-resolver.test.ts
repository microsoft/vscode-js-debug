/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { promises as fsPromises } from 'fs';
import { join, resolve } from 'path';
import { LocalFsUtils } from '../../common/fsUtils';
import { Logger } from '../../common/logging/logger';
import { fixDriveLetter } from '../../common/pathUtils';
import { resetCaseSensitivePaths, setCaseSensitivePaths } from '../../common/urlUtils';
import { NodeSourcePathResolver } from '../../targets/node/nodeSourcePathResolver';

const fsUtils = new LocalFsUtils(fsPromises);

describe('node source path resolver', () => {
  describe('url to path', () => {
    const defaultOptions = {
      workspaceFolder: 'file:///',
      resolveSourceMapLocations: null,
      basePath: __dirname,
      remoteRoot: null,
      localRoot: null,
      sourceMapOverrides: { 'webpack:///*': `${__dirname}/*` },
    };

    it('resolves absolute', async () => {
      const r = new NodeSourcePathResolver(
        fsUtils,
        undefined,
        defaultOptions,
        await Logger.test(),
      );
      expect(await r.urlToAbsolutePath({ url: 'file:///src/index.js' })).to.equal(
        resolve('/src/index.js'),
      );
    });

    it('escapes regex parts segments', async () => {
      if (process.platform === 'win32') {
        const r = new NodeSourcePathResolver(
          fsUtils,
          undefined,
          {
            ...defaultOptions,
            workspaceFolder: 'C:\\some\\workspa*ce\\folder',
            basePath: 'C:\\some\\workspa*ce\\folder',
            resolveSourceMapLocations: [
              'C:\\some\\workspa*ce\\folder/**',
              'C:\\some\\workspa*ce\\folder/../**',
              'C:\\some\\workspa*ce\\folder/../foo/**',
            ],
          },
          await Logger.test(),
        );
        expect((r as unknown as Record<string, string[]>).resolvePatterns).to.deep.equal([
          'C:/some/workspa\\*ce/folder/**',
          'C:/some/workspa\\*ce/**',
          'C:/some/workspa\\*ce/foo/**',
        ]);
      }
    });

    it('fixes regex escape issue #1554', async () => {
      if (process.platform === 'win32') {
        const r = new NodeSourcePathResolver(
          fsUtils,
          undefined,
          {
            ...defaultOptions,
            workspaceFolder: 'C:\\Users\\Segev\\prj\\swimm\\ide\\extensions\\vscode',
            basePath: 'C:\\Users\\Segev\\prj\\swimm\\ide\\extensions\\vscode',
            resolveSourceMapLocations: [
              'C:\\Users\\Segev\\prj\\swimm\\ide\\extensions\\vscode/**',
              'C:\\Users\\Segev\\prj\\swimm\\ide\\extensions\\vscode/../../../packages/shared/dist/**',
              'C:\\Users\\Segev\\prj\\swimm\\ide\\extensions\\vscode/../../../packages/swimmagic/dist/**',
              'C:\\Users\\Segev\\prj\\swimm\\ide\\extensions\\vscode/../../../packages/editor/dist/**',
              'C:\\Users\\Segev\\prj\\swimm\\ide\\extensions\\vscode/../../server/dist/**',
              '!**/node_modules/**',
            ],
          },
          await Logger.test(),
        );
        expect(
          r.shouldResolveSourceMap({
            compiledPath: 'c:\\Users\\Segev\\prj\\swimm\\ide\\server\\dist\\app.js',
            sourceMapUrl: 'file:///c:/Users/Segev/prj/swimm/ide/server/dist/app.js.map',
          }),
        ).to.be.true;
      }
    });

    it('resolves unc paths', async () => {
      if (process.platform !== 'win32') {
        return;
      }

      const r = new NodeSourcePathResolver(
        fsUtils,
        undefined,
        defaultOptions,
        await Logger.test(),
      );
      expect(
        await r.urlToAbsolutePath({
          url: 'file:////mac/Home/Github/js-debug-demos/node/main.js',
        }),
      ).to.equal(resolve('\\\\mac\\Home\\Github\\js-debug-demos\\node\\main.js'));
    });

    it('normalizes roots (win -> posix) ', async () => {
      const r = new NodeSourcePathResolver(
        fsUtils,
        undefined,
        {
          ...defaultOptions,
          remoteRoot: 'C:\\Source',
          localRoot: '/dev/src',
        },
        await Logger.test(),
      );

      expect(await r.urlToAbsolutePath({ url: 'file:///c:/source/foo/bar.js' })).to.equal(
        '/dev/src/foo/bar.js',
      );
    });

    it('normalizes roots (posix -> win) ', async () => {
      const r = new NodeSourcePathResolver(
        fsUtils,
        undefined,
        {
          ...defaultOptions,
          remoteRoot: '/dev/src',
          localRoot: 'C:\\Source',
        },
        await Logger.test(),
      );

      expect(await r.urlToAbsolutePath({ url: 'file:///dev/src/foo/bar.js' })).to.equal(
        'c:\\Source\\foo\\bar.js',
      );
    });

    it('places relative paths in node_internals', async () => {
      const r = new NodeSourcePathResolver(
        fsUtils,
        undefined,
        defaultOptions,
        await Logger.test(),
      );

      expect(
        await r.urlToAbsolutePath({
          url: 'internal.js',
        }),
      ).to.equal('<node_internals>/internal.js');
    });

    it('applies source map overrides', async () => {
      const r = new NodeSourcePathResolver(
        fsUtils,
        undefined,
        defaultOptions,
        await Logger.test(),
      );

      expect(
        await r.urlToAbsolutePath({
          url: 'webpack:///hello.js',
          map: { sourceRoot: '', metadata: { compiledPath: 'hello.js' } } as any,
        }),
      ).to.equal(fixDriveLetter(join(__dirname, 'hello.js')));
    });

    it('loads local node internals (#823)', async () => {
      const r = new NodeSourcePathResolver(fsUtils, undefined, defaultOptions, Logger.null);

      expect(await r.urlToAbsolutePath({ url: 'node:url' })).to.equal(
        join(__dirname, 'lib/url.js'),
      );
      expect(await r.urlToAbsolutePath({ url: 'node:internal/url.js' })).to.equal(
        join(__dirname, 'lib/internal/url.js'),
      );
    });

    describe('source map filtering', () => {
      const testTable = {
        'matches paths': {
          locs: ['/foo/bar/**', '!**/node_modules/**'],
          map: 'file:///foo/bar/baz/my.map.js',
          ok: true,
        },
        'is case sensitive on unix': {
          locs: ['/foo/BAR/**', '!**/node_modules/**'],
          map: 'file:////bar/my.map.js',
          ok: false,
          caseSensitive: true,
        },
        'does not match paths outside of locations': {
          locs: ['/foo/bar/**', '!**/node_modules/**'],
          map: 'file:////bar/my.map.js',
          ok: false,
        },
        'applies negations': {
          locs: ['/foo/bar/**', '!**/node_modules/**'],
          map: 'file:///foo/bar/node_modules/my.map.js',
          ok: false,
        },
        'matches win32 paths, case insensitive': {
          locs: ['c:\\foo\\BAR\\**', '!**\\node_modules\\**'],
          map: 'file:///c:/foo/bar/BAZ/my.map.js',
          ok: true,
          caseSensitive: false,
        },
        'applies win32 negations': {
          locs: ['c:\\foo\\bar\\**', '!**\\node_modules\\**'],
          map: 'file:///c:/foo/bar/node_modules/my.map.js',
          ok: false,
        },
        'works for http urls, case insensitive': {
          locs: ['https://EXAMPLE.com/**'],
          map: 'https://example.COM/my.map.js',
          ok: true,
        },
      };

      afterEach(() => resetCaseSensitivePaths());

      for (const key of Object.keys(testTable)) {
        const tcase = testTable[key];
        const { locs, map, ok } = tcase;
        const caseSensitive = 'caseSensitive' in tcase && tcase.caseSensitive;

        it(key, async () => {
          setCaseSensitivePaths(caseSensitive);

          const resolver = new NodeSourcePathResolver(
            fsUtils,
            undefined,
            {
              ...defaultOptions,
              resolveSourceMapLocations: locs,
            },
            await Logger.test(),
          );

          const result = await resolver.urlToAbsolutePath({
            url: 'webpack:///hello.js',
            map: { metadata: { sourceMapUrl: map, compiledPath: map }, sourceRoot: '' } as any,
          });

          if (ok) {
            expect(result && fixDriveLetter(result)).to.equal(
              fixDriveLetter(join(__dirname, 'hello.js')),
            );
          } else {
            expect(result).to.be.undefined;
          }
        });
      }
    });
  });
});
