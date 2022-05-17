/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import dataUriToBuffer from 'data-uri-to-buffer';
import { RawIndexMap, RawSourceMap } from 'source-map';
import Dap from '../../dap/api';
import { stubbedDapApi, StubDapApi } from '../../dap/stubbedApi';
import { Logger } from '../logging/logger';
import { SourceMapFactory } from './sourceMapFactory';

const sampleSource = 'console.log(123)';
const basicSourceMap: RawSourceMap = {
  version: 3,
  sources: ['one.js'],
  sourcesContent: [sampleSource],
  names: [],
  file: '',
  mappings: '',
};
const indexedSourceMap: RawIndexMap = {
  version: 3,
  sections: [
    {
      offset: { line: 0, column: 100 },
      map: basicSourceMap,
    },
  ],
};

describe('SourceMapFactory', () => {
  let stubDap: StubDapApi;

  beforeEach(() => {
    stubDap = stubbedDapApi();
  });

  it('loads source-maps', async () => {
    const factory = new SourceMapFactory(
      {
        rebaseRemoteToLocal() {
          return '/tmp/local';
        },
        rebaseLocalToRemote() {
          return '/tmp/remote';
        },
        shouldResolveSourceMap() {
          return true;
        },
        urlToAbsolutePath() {
          return Promise.resolve('/tmp/abs');
        },
        absolutePathToUrlRegexp() {
          return undefined;
        },
      },
      {
        fetch(url) {
          return Promise.resolve({
            ok: true,
            body: dataUriToBuffer(url).toString('utf8'),
            url: url,
            statusCode: 500,
          });
        },
        fetchJson<T>() {
          return Promise.resolve({ ok: true, body: {} as T, url: '', statusCode: 200 });
        },
      },
      stubDap as unknown as Dap.Api,
      Logger.null,
    );

    const map = await factory.load({
      sourceMapUrl:
        'data:application/json;base64,' +
        Buffer.from(JSON.stringify(indexedSourceMap)).toString('base64'),
      compiledPath: '/tmp/local/one.js',
    });

    expect(map.sources).to.eql(['one.js']);
  });
});
