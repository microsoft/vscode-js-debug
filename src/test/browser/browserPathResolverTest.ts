/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { stub, SinonStub } from 'sinon';
import { expect } from 'chai';
import { BrowserSourcePathResolver } from '../../targets/browser/browserPathResolver';
import { fsModule } from '../../common/fsUtils';
import { defaultSourceMapPathOverrides } from '../../configuration';
import { Logger } from '../../common/logging/logger';
import { testFixturesDir } from '../test';

describe('browserPathResolver.urlToAbsolutePath', () => {
  let fsExistStub: SinonStub<[fs.PathLike, (cb: boolean) => void], void>;
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

  describe('absolutePathToUrl', () => {
    const resolver = new BrowserSourcePathResolver(
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
        {
          pathMapping: { '/': webRoot },
          clientID: client,
          baseUrl: 'http://localhost:60318/',
          sourceMapOverrides: defaultSourceMapPathOverrides(webRoot),
          localRoot: null,
          remoteRoot: null,
          resolveSourceMapLocations: null,
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
