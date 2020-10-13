/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { PathLike, promises as fsPromises } from 'fs';
import * as path from 'path';
import { SinonStub, stub } from 'sinon';
import { IVueFileMapper, VueFileMapper, VueHandling } from '../../adapter/vueFileMapper';
import { FileGlobList } from '../../common/fileGlobList';
import { fsModule, IFsUtils, LocalFsUtils } from '../../common/fsUtils';
import { Logger } from '../../common/logging/logger';
import { ISourceMapMetadata, SourceMap } from '../../common/sourceMaps/sourceMap';
import { defaultSourceMapPathOverrides } from '../../configuration';
import { BrowserSourcePathResolver } from '../../targets/browser/browserPathResolver';
import { testFixturesDir } from '../test';

export const testVueMapper: IVueFileMapper = {
  lookup: async url => path.join(testFixturesDir, 'web', 'looked up', url),
  getVueHandling: url =>
    url.includes('lookup.vue')
      ? VueHandling.Lookup
      : url.includes('omit.vue')
      ? VueHandling.Omit
      : VueHandling.Unhandled,
};

describe('browserPathResolver.urlToAbsolutePath', () => {
  let fsExistStub: SinonStub<[PathLike, (cb: boolean) => void], void>;

  before(() => {
    fsExistStub = stub(fsModule, 'exists').callsFake((path, cb) => {
      switch (path) {
        case 'c:\\Users\\user\\Source\\Repos\\Angular Project\\ClientApp\\src\\app\\app.component.html':
          return cb(true);
        case 'c:\\Users\\user\\Source\\Repos\\Angular Project\\wwwroot\\src\\app\\app.component.html':
          return cb(false);
        default:
          throw Error(`Unknown path ${path}`);
      }
    });
  });

  describe('vue', () => {
    const resolver = new BrowserSourcePathResolver(
      testVueMapper,
      new LocalFsUtils(fsPromises),
      {
        pathMapping: { '/': path.join(testFixturesDir, 'web') },
        clientID: 'vscode',
        baseUrl: 'http://localhost:1234/',
        sourceMapOverrides: defaultSourceMapPathOverrides(path.join(testFixturesDir, 'web')),
        localRoot: null,
        remoteRoot: null,
        resolveSourceMapLocations: null,
        remoteFilePrefix: undefined,
      },
      Logger.null,
    );

    const fakeMap = ({
      metadata: {
        compiledPath: path.join(testFixturesDir, 'web', 'bundle.js'),
        sourceMapUrl: path.join(testFixturesDir, 'web', 'bundle.map.js'),
      } as ISourceMapMetadata,
    } as unknown) as SourceMap;

    it('looks up vue paths', async () => {
      expect(
        await resolver.urlToAbsolutePath({
          url: 'lookup.vue',
          map: fakeMap,
        }),
      ).to.equal(path.join(testFixturesDir, 'web', 'looked up', 'lookup.vue'));
    });

    it('omits vue paths', async () => {
      expect(
        await resolver.urlToAbsolutePath({
          url: 'omit.vue',
          map: fakeMap,
        }),
      ).to.be.undefined;
    });

    it('uses default handling', async () => {
      expect(
        await resolver.urlToAbsolutePath({
          url: 'whatever.vue',
          map: fakeMap,
        }),
      ).to.equal(path.join(testFixturesDir, 'web', 'whatever.vue'));
    });

    describe('VueFileMapper', () => {
      const mapper = new VueFileMapper(
        new FileGlobList({ rootPath: testFixturesDir, patterns: ['**/*.vue'] }),
        {
          streamChildrenWithSourcemaps() {
            return Promise.resolve([]);
          },
          streamAllChildren(_files, onChild) {
            return Promise.all([
              onChild(path.join(testFixturesDir, 'web', 'a.vue')),
              onChild(path.join(testFixturesDir, 'web', 'b.vue')),
            ]);
          },
        },
      );

      it('has correct vue handling', () => {
        const ttable = new Map([
          ['webpack:///hello.vue?f00d', VueHandling.Lookup],
          ['webpack:///./components/hello.vue?f00d', VueHandling.Omit],
          ['webpack:///unrelated.js', VueHandling.Unhandled],
        ]);

        for (const [sourceUrl, expected] of ttable.entries()) {
          expect(mapper.getVueHandling(sourceUrl)).to.equal(expected);
        }
      });

      it('maps basenames to disk', async () => {
        expect(await mapper.lookup('webpack:///a.vue?f00d')).to.equal(
          path.join(testFixturesDir, 'web', 'a.vue'),
        );
        expect(await mapper.lookup('webpack:///q.vue?f00d')).to.be.undefined;
        expect(await mapper.lookup('webpack:///unrelated.js')).to.be.undefined;
      });
    });
  });

  class FakeLocalFsUtils {
    exists(path: string): Promise<boolean> {
      switch (path) {
        case 'c:\\Users\\user\\Source\\Repos\\Angular Project\\ClientApp\\src\\app\\app.component.html':
          return Promise.resolve(true);
        case 'c:\\Users\\user\\Source\\Repos\\Angular Project\\wwwroot\\src\\app\\app.component.html':
          return Promise.resolve(false);
        default:
          throw Error(`Unknown path ${path}`);
      }
    }
  }

  describe('absolutePathToUrl', () => {
    const resolver = new BrowserSourcePathResolver(
      testVueMapper,
      new LocalFsUtils(fsPromises),
      {
        pathMapping: {
          '/': path.join(testFixturesDir, 'web'),
          '/sibling': path.join(testFixturesDir, 'sibling-dir'),
        },
        clientID: 'vscode',
        baseUrl: 'http://localhost:1234/',
        sourceMapOverrides: defaultSourceMapPathOverrides(path.join(testFixturesDir, 'web')),
        localRoot: null,
        remoteRoot: null,
        resolveSourceMapLocations: null,
        remoteFilePrefix: undefined,
      },
      Logger.null,
    );

    it('selects webRoot correctly', () => {
      expect(
        resolver.absolutePathToUrl(path.join(testFixturesDir, 'web', 'foo', 'bar.html')),
      ).to.equal('http://localhost:1234/foo/bar.html');
      expect(
        resolver.absolutePathToUrl(path.join(testFixturesDir, 'sibling-dir', 'foo', 'bar.html')),
      ).to.equal('http://localhost:1234/sibling/foo/bar.html');
    });

    it('falls back if not in any webroot', () => {
      expect(resolver.absolutePathToUrl(path.join(testFixturesDir, 'foo', 'bar.html'))).to.equal(
        'http://localhost:1234/../foo/bar.html',
      );
    });
  });

  [
    ['visualstudio', 'ClientApp'],
    ['vscode', 'wwwroot'],
  ].forEach(([client, folder]) => {
    it(`returns ${folder} for ${client} if the webroot path doesn't exist and the modified path does`, async () => {
      const webRoot = 'c:\\Users\\user\\Source\\Repos\\Angular Project\\wwwroot';

      const resolver = new BrowserSourcePathResolver(
        testVueMapper,
        new FakeLocalFsUtils() as IFsUtils,
        {
          pathMapping: { '/': webRoot },
          clientID: client,
          baseUrl: 'http://localhost:60318/',
          sourceMapOverrides: defaultSourceMapPathOverrides(webRoot),
          localRoot: null,
          remoteRoot: null,
          resolveSourceMapLocations: null,
          remoteFilePrefix: undefined,
        },
        await Logger.test(),
      );

      const url = 'webpack:///src/app/app.component.html';
      const absolutePath = await resolver.urlToAbsolutePath({
        url,
        map: { metadata: { sourceRoot: '' } } as any,
      });

      expect(absolutePath).to.equal(
        `c:\\Users\\user\\Source\\Repos\\Angular Project\\${folder}\\src\\app\\app.component.html`,
      );
    });
  });

  after(() => {
    fsExistStub.restore();
  });
});
