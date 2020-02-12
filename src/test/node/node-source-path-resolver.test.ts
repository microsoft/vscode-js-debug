/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { NodeSourcePathResolver } from '../../targets/node/nodeSourcePathResolver';
import { expect } from 'chai';
import { join, resolve } from 'path';
import { setCaseSensitivePaths, resetCaseSensitivePaths } from '../../common/urlUtils';
import { Logger } from '../../common/logging/logger';

describe('node source path resolver', () => {
  describe('url to path', () => {
    const defaultOptions = {
      resolveSourceMapLocations: null,
      basePath: __dirname,
      remoteRoot: null,
      localRoot: null,
      sourceMapOverrides: { 'webpack:///*': `${__dirname}/*` },
    };

    it('resolves absolute', async () => {
      const r = new NodeSourcePathResolver(defaultOptions, await Logger.test());
      expect(await r.urlToAbsolutePath({ url: 'file:///src/index.js' })).to.equal(
        resolve('/src/index.js'),
      );
    });

    it('normalizes roots (win -> posix) ', async () => {
      const r = new NodeSourcePathResolver(
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
      const r = new NodeSourcePathResolver(defaultOptions, await Logger.test());

      expect(
        await r.urlToAbsolutePath({
          url: 'internal.js',
        }),
      ).to.equal('<node_internals>/internal.js');
    });

    it('applies source map overrides', async () => {
      const r = new NodeSourcePathResolver(defaultOptions, await Logger.test());

      expect(
        await r.urlToAbsolutePath({
          url: 'webpack:///hello.js',
          map: { sourceRoot: '', metadata: { compiledPath: 'hello.js' } } as any,
        }),
      ).to.equal(join(__dirname, 'hello.js'));
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
            expect(result).to.equal(join(__dirname, 'hello.js'));
          } else {
            expect(result).to.be.undefined;
          }
        });
      }
    });
  });
});
