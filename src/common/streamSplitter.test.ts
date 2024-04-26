/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as assert from 'assert';
import { Writable } from 'stream';
import { StreamSplitter } from './streamSplitter';

describe('StreamSplitter', () => {
  it('should split a stream', done => {
    const chunks: string[] = [];
    const splitter = new StreamSplitter('\n');
    const writable = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });

    splitter.pipe(writable);
    splitter.write('hello\nwor');
    splitter.write('ld\n');
    splitter.write('foo\nbar\nz');
    splitter.end(() => {
      assert.deepStrictEqual(chunks, ['hello', 'world', 'foo', 'bar', 'z']);
      done();
    });
  });
});
