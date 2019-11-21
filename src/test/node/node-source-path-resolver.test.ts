/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { NodeSourcePathResolver } from '../../targets/node/nodeSourcePathResolver';
import { expect } from 'chai';
import { join } from 'path';
import { setCaseSensitivePaths, resetCaseSensitivePaths } from '../../common/urlUtils';

describe('node source path resolver', () => {
  describe('url to path', () => {
    const defaultOptions = {
      resolveSourceMapLocations: null,
      basePath: __dirname,
      remoteRoot: null,
      localRoot: null,
      sourceMapOverrides: { 'webpack:///*': '*' },
    };
    it.skip('resolves absolute', () => {
      const r = new NodeSourcePathResolver(defaultOptions);

      expect(r.urlToAbsolutePath({ url: 'file:///src/index.js' })).to.equal('/src/index.js');
    });

    it('normalizes roots (win -> posix) ', () => {
      const r = new NodeSourcePathResolver({
        ...defaultOptions,
        remoteRoot: 'C:\\Source',
        localRoot: '/dev/src',
      });

      expect(r.urlToAbsolutePath({ url: 'file:///c:/source/foo/bar.js' })).to.equal(
        '/dev/src/foo/bar.js',
      );
    });

    it('normalizes roots (posix -> win) ', () => {
      const r = new NodeSourcePathResolver({
        ...defaultOptions,
        remoteRoot: '/dev/src',
        localRoot: 'C:\\Source',
      });

      expect(r.urlToAbsolutePath({ url: 'file:///dev/src/foo/bar.js' })).to.equal(
        'c:\\Source\\foo\\bar.js',
      );
    });

    it('applies source map overrides', () => {
      const r = new NodeSourcePathResolver(defaultOptions);

      expect(r.urlToAbsolutePath({ url: 'webpack:///hello.js' })).to.equal(
        join(__dirname, 'hello.js'),
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

        it(key, () => {
          setCaseSensitivePaths(caseSensitive);

          const resolver = new NodeSourcePathResolver({
            ...defaultOptions,
            resolveSourceMapLocations: locs,
          });

          const result = resolver.urlToAbsolutePath({
            url: 'webpack:///hello.js',
            map: { metadata: { sourceMapUrl: map } } as any,
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
