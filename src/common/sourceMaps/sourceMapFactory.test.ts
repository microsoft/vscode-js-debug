/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import dataUriToBuffer from 'data-uri-to-buffer';
import { stub } from 'sinon';
import { RawIndexMap, RawSourceMap } from 'source-map';
import { stubbedDapApi, StubDapApi } from '../../dap/stubbedApi';
import { Logger } from '../logging/logger';
import { RawIndexMapUnresolved, SourceMapFactory } from './sourceMapFactory';

const toDataUri = (obj: unknown) =>
  'data:application/json;base64,' + Buffer.from(JSON.stringify(obj)).toString('base64');

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
const unresolvedIndexedSourceMap: RawIndexMapUnresolved = {
  version: 3,
  sections: [
    {
      offset: { line: 0, column: 100 },
      url: toDataUri(basicSourceMap),
    },
  ],
};

describe('SourceMapFactory', () => {
  let stubDap: StubDapApi;
  let factory: SourceMapFactory;

  beforeEach(() => {
    stubDap = stubbedDapApi();
    factory = new SourceMapFactory(
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
      stubDap.actual,
      Logger.null,
    );
  });

  it('loads indexed source-maps', async () => {
    const map = await factory.load({
      sourceMapUrl: toDataUri(indexedSourceMap),
      compiledPath: '/tmp/local/one.js',
    });

    expect(map.sources).to.eql(['one.js']);
  });

  it('loads indexed source-maps with unresolved children', async () => {
    const map = await factory.load({
      sourceMapUrl: toDataUri(unresolvedIndexedSourceMap),
      compiledPath: '/tmp/local/one.js',
    });

    expect(map.sources).to.eql(['one.js']);
  });

  it('warns without failure if a single nested child fails', async () => {
    const warn = stub(Logger.null, 'warn');
    const map = await factory.load({
      sourceMapUrl: toDataUri({
        ...unresolvedIndexedSourceMap,
        sections: [
          ...unresolvedIndexedSourceMap.sections,
          { url: 'invalid', offset: { line: 0, column: 0 } },
        ],
      }),
      compiledPath: '/tmp/local/one.js',
    });

    expect(map.sources).to.eql(['one.js']);
    expect(warn.called).to.be.true;
    warn.restore();
  });
});
