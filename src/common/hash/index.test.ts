/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { ChildProcess } from 'child_process';
import del from 'del';
import { join } from 'path';
import { Hasher } from '.';
import { createFileTree, getTestDir } from '../../test/createFileTree';

describe('hash process', () => {
  let hasher: Hasher;
  let testDir: string;

  before(() => {
    hasher = new Hasher();
  });

  beforeEach(() => {
    testDir = getTestDir();
  });

  afterEach(async () => {
    await del(testDir, { force: true });
  });

  after(() => {
    hasher.dispose();
  });

  /**
   *  different encodings for the same string: "\"1111111111111111111111111111111111111111111\""
   */
  // prettier-ignore
  const utf8NoBOM = Buffer.from([0x22, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31,
    0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31,
    0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31,
    0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31,
    0x31, 0x22]);
  // prettier-ignore
  const utf8BOM = Buffer.from([
    0xEF, 0xBB, 0xBF, 0x22, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31,
    0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31,
    0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31,
    0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x22]);
  // prettier-ignore
  const utf16BigEndianBOM = Buffer.from([
    0xFE, 0xFF, 0x00, 0x22, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31,
    0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31,
    0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31,
    0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31,
    0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31,
    0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31,
    0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31,
    0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x22]);
  // prettier-ignore
  const utf16LittleEndianBOM = Buffer.from([
    0xFF, 0xFE, 0x22, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00,
    0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00,
    0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00,
    0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00,
    0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00,
    0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00,
    0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x31, 0x00,
    0x31, 0x00, 0x31, 0x00, 0x31, 0x00, 0x22, 0x00]);

  it('hash bom', async () => {
    const expected = '1d9f277f134f31935a286ff810acdf571af3498e';
    expect(await hasher.hashBytes(utf8NoBOM)).to.equal(expected);
    expect(await hasher.hashBytes(utf8BOM)).to.equal(expected);
    expect(await hasher.hashBytes(utf16BigEndianBOM)).to.equal(expected);
    expect(await hasher.hashBytes(utf16LittleEndianBOM)).to.equal(expected);
  });

  it('hash from file', async () => {
    const expected = '1d9f277f134f31935a286ff810acdf571af3498e';
    createFileTree(testDir, {
      utf8NoBOM,
      utf8BOM,
      utf16BigEndianBOM,
      utf16LittleEndianBOM,
    });

    expect(await hasher.hashFile(join(testDir, 'utf8NoBOM'))).to.equal(expected);
    expect(await hasher.hashFile(join(testDir, 'utf8BOM'))).to.equal(expected);
    expect(await hasher.hashFile(join(testDir, 'utf16BigEndianBOM'))).to.equal(expected);
    expect(await hasher.hashFile(join(testDir, 'utf16LittleEndianBOM'))).to.equal(expected);
  });

  /**
   * Simple script with some emojis in a comment to test hashing of multi-byte code points
   */
  // prettier-ignore
  const multiByteCodePoints = Buffer.from([
    0xEF, 0xBB, 0xBF, 0x66, 0x75, 0x6E, 0x63, 0x74, 0x69, 0x6F, 0x6E, 0x20,
    0x62, 0x6C, 0x75, 0x62, 0x28, 0x29, 0x20, 0x7B, 0x0D, 0x0A, 0x09, 0x2F,
    0x2F, 0x20, 0x67, 0x72, 0x65, 0x61, 0x74, 0x20, 0x73, 0x74, 0x75, 0x66,
    0x66, 0x20, 0xF0, 0x9F, 0x98, 0x81, 0xF0, 0x9F, 0x98, 0x82, 0xF0, 0x9F,
    0x98, 0x83, 0xF0, 0x9F, 0x98, 0x84, 0xF0, 0x9F, 0x98, 0x81, 0xF0, 0x9F,
    0x98, 0x82, 0xF0, 0x9F, 0x98, 0x83, 0xF0, 0x9F, 0x98, 0x84, 0xF0, 0x9F,
    0x98, 0x81, 0xF0, 0x9F, 0x98, 0x82, 0xF0, 0x9F, 0x98, 0x83, 0xF0, 0x9F,
    0x98, 0x84, 0xF0, 0x9F, 0x98, 0x81, 0xF0, 0x9F, 0x98, 0x82, 0xF0, 0x9F,
    0x98, 0x83, 0xF0, 0x9F, 0x98, 0x84, 0x0D, 0x0A, 0x09, 0x72, 0x65, 0x74,
    0x75, 0x72, 0x6E, 0x20, 0x32, 0x35, 0x3B, 0x0D, 0x0A, 0x7D]);

  it('hash code points', async () => {
    expect(await hasher.hashBytes(multiByteCodePoints.toString('utf-8'))).to.equal(
      '0397c2213841ff201f50229790141ac12977acd1',
    );
  });

  it('verifies files', async () => {
    createFileTree(testDir, {
      'test.js': 'hello world',
    });

    const result = await hasher.hashFile(join(testDir, 'test.js'));
    expect(result).to.equal('1ac3c2bf96f77c71394f85ba44fd90055bb72820');
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
    const r = hasher.hashBytes('hello world');
    ((hasher as unknown) as { instance: ChildProcess }).instance.kill();
    expect(await r).to.equal('1ac3c2bf96f77c71394f85ba44fd90055bb72820');
  });

  it('errors if the hasher crashes multiple times', async () => {
    const deadHasher = new Hasher();
    const h = (deadHasher as unknown) as { getProcess(): ChildProcess };
    for (let i = 0; i < 4; i++) {
      const p = h.getProcess();
      p.kill();
      await new Promise(r => p.addListener('exit', r));
    }

    await expect(deadHasher.hashBytes('hello')).to.be.rejectedWith('unexpectedly exited');
  });
});
