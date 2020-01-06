/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as fs from 'fs';
import { stub, SinonStub } from 'sinon';
import { expect } from 'chai';
import { BrowserSourcePathResolver } from '../../targets/browser/browserPathResolver';
import { fsModule } from '../../common/fsUtils';

describe('browserPathResolver.urlToAbsolutePath', () => {
  let fsExistStub: SinonStub<[fs.PathLike, (cb: boolean) => void], void>;
  before(() => {
    fsExistStub = stub(fsModule, 'exists').callsFake((path, cb) => {
      switch (path) {
        case 'C:\\Users\\user\\Source\\Repos\\Angular Project\\ClientApp\\src\\app\\app.component.html':
          return cb(true);
        case 'C:\\Users\\user\\Source\\Repos\\Angular Project\\wwwroot\\src\\app\\app.component.html':
          return cb(false);
        default:
          throw Error('Unknown path');
      }
    });
  });

  [
    ['visualstudio', 'ClientApp'],
    ['vscode', 'wwwroot'],
  ].forEach(([client, folder]) => {
    it.only(`returns ${folder} for ${client} if the webroot path doesn't exist and the modified path does`, async () => {
      const webRoot = 'C:\\Users\\user\\Source\\Repos\\Angular Project\\wwwroot';

      const defaultSourceMapOverrides = {
        'meteor://💻app/*': '/*',
        'webpack://?:*/*': '*',
        'webpack:///./~/*': '/node_modules/*',
      };

      const resolver = new BrowserSourcePathResolver({
        webRoot,
        clientID: client,
        baseUrl: 'http://localhost:60318/',
        sourceMapOverrides: defaultSourceMapOverrides,
        localRoot: null,
        remoteRoot: null,
        resolveSourceMapLocations: null,
      });

      const url = 'webpack:///src/app/app.component.html';
      const absolutePath = await resolver.urlToAbsolutePath({ url });

      expect(absolutePath).to.equal(
        `C:\\Users\\user\\Source\\Repos\\Angular Project\\${folder}\\src\\app\\app.component.html`,
      );
    });
  });

  after(() => {
    fsExistStub.restore();
  });
});
