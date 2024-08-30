/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import esbuild from 'esbuild';
import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { Worker } from 'worker_threads';
import { createFileTree, getTestDir } from '../../test/createFileTree';
import { Hasher } from '.';
import { HashMode } from './hash';

const hashTestCaseDir = resolve(__dirname, '../../../testWorkspace/hashTestCases');

describe('hash process', function() {
  this.timeout(15_000);
  let hasher: Hasher;
  let hashScript: string;
  let testDir: string;

  before(async () => {
    hashScript = join(hashTestCaseDir, 'hash.js');
    const src = await esbuild.transform(await fs.readFile(join(__dirname, 'hash.ts')), {
      loader: 'ts',
    });
    fs.writeFile(hashScript, src.code);

    hasher = new Hasher(undefined, hashScript);
  });

  after(async () => {
    await fs.rm(hashScript);
  });

  beforeEach(() => {
    testDir = getTestDir();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  after(() => {
    hasher.dispose();
  });

  describe('chromehash', () => {
    /**
     *  different encodings for the same string: "\"1111111111111111111111111111111111111111111\""
     */
    // dprint-ignore
    const utf8NoBOM = Buffer.from([0x22, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31,
    0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31,
    0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31,
    0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31,
    0x31, 0x22]);
    // dprint-ignore
    const utf8BOM = Buffer.from([
    0xEF, 0xBB, 0xBF, 0x22, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31,
    0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31,
    0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31,
    0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x22]);
    // dprint-ignore
    const utf16BigEndianBOM = Buffer.from([
    0xFE, 0xFF, 0x00, 0x22, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31,
    0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31,
    0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31,
    0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31,
    0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31,
    0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31,
    0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31,
    0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x22]);
    // dprint-ignore
    const utf16LittleEndianBOM = Buffer.from([
    0xFF, 0xFE, 0x22, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00,
    0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00,
    0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00,
    0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00,
    0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00,
    0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00,
    0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00,
    0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x22, 0x00]);

    it('bytes', async () => {
      const expected = '1d9f277f134f31935a286ff810acdf571af3498e';
      expect(await hasher.hashBytes(HashMode.Chromehash, utf8NoBOM)).to.equal(expected);
      expect(await hasher.hashBytes(HashMode.Chromehash, utf8BOM)).to.equal(expected);
      expect(await hasher.hashBytes(HashMode.Chromehash, utf16BigEndianBOM)).to.equal(expected);
      expect(await hasher.hashBytes(HashMode.Chromehash, utf16LittleEndianBOM)).to.equal(
        expected,
      );
    });

    it('files', async () => {
      expect(await hasher.hashFile(HashMode.Chromehash, join(hashTestCaseDir, 'blns.js'))).to
        .equal(
          '3b33b447a9e19333659bb21c05ce7a0f414776b9',
        );
      expect(
        await hasher.hashFile(HashMode.Chromehash, join(hashTestCaseDir, 'simple.js')),
      ).to.equal('1283dfddaa33715f0e953c443e071f361de1c9c5');
      expect(
        await hasher.hashFile(HashMode.Chromehash, join(hashTestCaseDir, 'utf16be.js')),
      ).to.equal('1283dfddaa33715f52d186d24885740d1de1c9c5');
      expect(
        await hasher.hashFile(HashMode.Chromehash, join(hashTestCaseDir, 'utf16le.js')),
      ).to.equal('1283dfddaa33715f52d186d24885740d1de1c9c5');
      expect(
        await hasher.hashFile(HashMode.Chromehash, join(hashTestCaseDir, 'utf8-bom.js')),
      ).to.equal('1283dfddaa33715f0e953c443e071f361de1c9c5');
    });

    it('verifies files when hash matches', async () => {
      createFileTree(testDir, {
        'test.js': 'hello world',
      });

      const result = await hasher.verifyFile(
        join(testDir, 'test.js'),
        '1ac3c2bf96f77c71394f85ba44fd90055bb72820',
        false,
      );
      expect(result).to.be.true;
    });
  });

  describe('SHA', () => {
    it('files', async () => {
      expect(await hasher.hashFile(HashMode.SHA256, join(hashTestCaseDir, 'blns.js'))).to.equal(
        'bd2f90038c4ea269f2f610d3502de20f98eb2359eec6ed2da152c52cc861d596',
      );
      expect(await hasher.hashFile(HashMode.SHA256, join(hashTestCaseDir, 'simple.js'))).to
        .equal(
          'a8217b64f8d6315a5e8fcdc751bff2069a118575d0d9327fc069fb4f060f04a2',
        );
      expect(await hasher.hashFile(HashMode.SHA256, join(hashTestCaseDir, 'utf16be.js'))).to
        .equal(
          'f7bc3e22e6000869ab4a70052ee353336ac8ff9b63e8d2a343a4fe6e659def9a',
        );
      expect(await hasher.hashFile(HashMode.SHA256, join(hashTestCaseDir, 'utf16le.js'))).to
        .equal(
          'f7bc3e22e6000869ab4a70052ee353336ac8ff9b63e8d2a343a4fe6e659def9a',
        );
      expect(await hasher.hashFile(HashMode.SHA256, join(hashTestCaseDir, 'utf8-bom.js'))).to
        .equal(
          'a8217b64f8d6315a5e8fcdc751bff2069a118575d0d9327fc069fb4f060f04a2',
        );
    });

    it('verifies files when hash matches', async () => {
      const a = await hasher.verifyFile(
        join(hashTestCaseDir, 'simple.js'),
        'a8217b64f8d6315a5e8fcdc751bff2069a118575d0d9327fc069fb4f060f04a2',
        false,
      );
      expect(a).to.be.true;

      const b = await hasher.verifyFile(
        join(hashTestCaseDir, 'simple.js'),
        'b8217b64f8d6315a5e8fcdc751bff2069a118575d0d9327fc069fb4f060f04a2',
        false,
      );
      expect(b).to.be.false;
    });
  });

  it('verifies if wrapped in node module', async () => {
    createFileTree(testDir, {
      'test.js': 'hello world',
    });

    const result = await hasher.verifyFile(
      join(testDir, 'test.js'),
      '070b3b0d4612ebf3602b8110696d56564a4f1e73',
      true,
    );
    expect(result).to.be.true;
  });

  it('verify fails if not existent', async () => {
    const result = await hasher.verifyFile(
      join(testDir, 'test.js'),
      '1ac3c2bf96f77c71394f85ba44fd90055bb72820',
      false,
    );
    expect(result).to.be.false;
  });

  it('verify fails if hash wrong', async () => {
    createFileTree(testDir, {
      'test.js': 'hello world',
    });

    const result = await hasher.verifyFile(join(testDir, 'test.js'), 'potato', false);
    expect(result).to.be.false;
  });

  it('verifies electron sources', async () => {
    /**
     * Sample from: https://github.com/lutzroeder/netron/blob/master/src/tar.js (via issue report)
     *
     * @license
     *
     * MIT License
     *
     * Copyright (c) Lutz Roeder
     *
     * Permission is hereby granted, free of charge, to any person obtaining a copy
     * of this software and associated documentation files (the "Software"), to deal
     * in the Software without restriction, including without limitation the rights
     * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
     * copies of the Software, and to permit persons to whom the Software is
     * furnished to do so, subject to the following conditions:
     *
     * The above copyright notice and this permission notice shall be included in all
     * copies or substantial portions of the Software.
     *
     * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
     * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
     * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
     * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
     * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
     * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
     * SOFTWARE.
     */
    const testFile =
      "/* jshint esversion: 6 */\n\nvar tar = tar || {};\n\ntar.Archive = class {\n\n    constructor(buffer) {\n        this._entries = [];\n        const reader = new tar.Reader(buffer, 0, buffer.length);\n        while (reader.peek()) {\n            this._entries.push(new tar.Entry(reader));\n            if (reader.match(512, 0)) {\n                break;\n            }\n        }\n    }\n\n    get entries() {\n        return this._entries;\n    }\n};\n\ntar.Entry = class {\n\n    constructor(reader) {\n        const header = reader.bytes(512);\n        reader.skip(-512);\n        let sum = 0;\n        for (let i = 0; i < header.length; i++) {\n            sum += (i >= 148 && i < 156) ? 32 : header[i];\n        }\n        this._name = reader.string(100);\n        reader.string(8); // file mode\n        reader.string(8); // owner\n        reader.string(8); // group\n        const size = parseInt(reader.string(12).trim(), 8); // size\n        reader.string(12); // timestamp\n        const checksum = parseInt(reader.string(8).trim(), 8); // checksum\n        if (isNaN(checksum) || sum != checksum) {\n            throw new tar.Error('Invalid tar archive.');\n        }\n        reader.string(1); // link indicator\n        reader.string(100); // name of linked file\n        reader.bytes(255);\n        this._data = reader.bytes(size);\n        reader.bytes(((size % 512) != 0) ? (512 - (size % 512)) : 0);\n    }\n\n    get name() {\n        return this._name;\n    }\n\n    get data() {\n        return this._data;\n    }\n};\n\ntar.Reader = class {\n\n    constructor(buffer) {\n        this._buffer = buffer;\n        this._position = 0;\n        this._end = buffer.length;\n    }\n\n    skip(offset) {\n        this._position += offset;\n        if (this._position > this._buffer.length) {\n            throw new tar.Error('Expected ' + (this._position - this._buffer.length) + ' more bytes. The file might be corrupted. Unexpected end of file.');\n        }\n    }\n\n    peek() {\n        return this._position < this._end;\n    }\n\n    match(size, value) {\n        if (this._position + size <= this._end) {\n            if (this._buffer.subarray(this._position, this._position + size).every((c) => c == value)) {\n                this._position += size;\n                return true;\n            }\n        }\n        return false;\n    }\n\n    bytes(size) {\n        const position = this._position;\n        this.skip(size);\n        return this._buffer.subarray(position, this._position);\n    }\n\n    string(size) {\n        const buffer = this.bytes(size);\n        let position = 0;\n        let str = '';\n        for (let i = 0; i < size; i++) {\n            const c = buffer[position++];\n            if (c == 0) {\n                break;\n            }\n            str += String.fromCharCode(c);\n        }\n        return str;\n    }\n};\n\ntar.Error = class extends Error {\n    constructor(message) {\n        super(message);\n        this.name = 'tar Error';\n    }\n};\n\nif (typeof module !== 'undefined' && typeof module.exports === 'object') {\n    module.exports.Archive = tar.Archive;\n}";

    createFileTree(testDir, {
      'test.js': testFile,
    });

    const result = await hasher.verifyFile(
      join(testDir, 'test.js'),
      '04f6b56f40d4c63b243404afc8a7afba03d8e774',
      true,
    );
    expect(result).to.be.true;
  });

  it('gracefully recovers on failure', async () => {
    const r = hasher.hashBytes(HashMode.Chromehash, 'hello world');
    (hasher as unknown as { instance: Worker }).instance.terminate();
    expect(await r).to.equal('1ac3c2bf96f77c71394f85ba44fd90055bb72820');
  });

  it('errors if the hasher crashes multiple times', async () => {
    const deadHasher = new Hasher();
    const h = deadHasher as unknown as { getProcess(): Worker };
    for (let i = 0; i < 4; i++) {
      const p = h.getProcess();
      p.terminate();
      await new Promise(r => p.addListener('exit', r));
    }

    await expect(deadHasher.hashBytes(HashMode.Chromehash, 'hello')).to.be.rejectedWith(
      'unexpectedly exited',
    );
  });
});
