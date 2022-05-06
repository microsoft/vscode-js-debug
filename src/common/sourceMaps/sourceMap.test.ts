/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { expect } from 'chai';
import { RawIndexMap, RawSourceMap, SourceMapConsumer } from 'source-map';
import { SourceMap } from './sourceMap';

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

describe('SourceMap', () => {
  it('loads basic source-maps', async () => {
    const map = new SourceMap(
      await new SourceMapConsumer(basicSourceMap),
      {
        sourceMapUrl: JSON.stringify(basicSourceMap),
        compiledPath: 'one.js',
      },
      '',
      ['one.js'],
      false,
    );

    expect(map.sourceContentFor('one.js')).to.eq(sampleSource);
  });

  it('loads indexed source-maps', async () => {
    const map = new SourceMap(
      await new SourceMapConsumer(indexedSourceMap),
      {
        sourceMapUrl: JSON.stringify(indexedSourceMap),
        compiledPath: 'one.js',
      },
      '',
      ['one.js'],
      false,
    );

    expect(map.sourceContentFor('one.js')).to.eq(sampleSource);
  });
});
