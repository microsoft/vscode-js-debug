/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { join } from 'path';
import { hashBytes, hashFile, verifyFile } from '../../common/hash';
import Dap from '../../dap/api';
import { createFileTree, ITestHandle, testFixturesDir, testWorkspace } from '../test';
import { itIntegrates, waitForPause } from '../testIntegrationUtils';

describe('sources', () => {
  async function dumpSource(p: ITestHandle, event: Dap.LoadedSourceEventParams, name: string) {
    p.log('\nSource event for ' + name);
    p.log(event);
    const content = await p.dap.source({
      sourceReference: event.source.sourceReference!,
      source: {
        path: event.source.path,
        sourceReference: event.source.sourceReference,
      },
    });
    p.log(`${content.mimeType}`);
    p.log('---------');
    p.log(content.content);
    p.log('---------');
  }

  itIntegrates('basic sources', async ({ r }) => {
    const p = await r.launchUrl('inlinescript.html');
    p.load();
    await dumpSource(p, await p.waitForSource('inline'), 'inline');
    p.addScriptTag('empty.js');
    await dumpSource(p, await p.waitForSource('empty.js'), 'empty.js');
    p.evaluate('17', 'doesnotexist.js');
    await dumpSource(p, await p.waitForSource('doesnotexist'), 'does not exist');
    p.addScriptTag('dir/helloworld.js');
    await dumpSource(p, await p.waitForSource('helloworld'), 'dir/helloworld');
    p.evaluate('42', '');
    await dumpSource(p, await p.waitForSource('eval'), 'eval');
    p.log(await p.dap.loadedSources({}), '\nLoaded sources: ');
    p.assertLog();
  });

  itIntegrates('updated content', async ({ r }) => {
    const p = await r.launchUrlAndLoad('index.html');
    p.cdp.Runtime.evaluate({ expression: 'content1//# sourceURL=test.js' });
    await dumpSource(p, await p.waitForSource('test'), 'test.js');
    p.cdp.Runtime.evaluate({ expression: 'content2//# sourceURL=test.js' });
    await dumpSource(p, await p.waitForSource('test'), 'test.js updated');
    p.log(await p.dap.loadedSources({}), '\nLoaded sources: ');
    p.assertLog();
  });

  itIntegrates('basic source map', async ({ r }) => {
    const p = await r.launchUrlAndLoad('index.html');
    p.addScriptTag('browserify/bundle.js');
    const sources = await Promise.all([
      p.waitForSource('index.ts'),
      p.waitForSource('module1.ts'),
      p.waitForSource('module2.ts'),
    ]);
    for (const source of sources) await dumpSource(p, source, '');
    p.assertLog();
  });

  itIntegrates('waiting for source map', async ({ r }) => {
    const p = await r.launchUrlAndLoad('index.html');
    await p.addScriptTag('browserify/bundle.js');
    p.dap.evaluate({ expression: `setTimeout(() => { window.throwError('error2')}, 0)` });
    await p.logger.logOutput(await p.dap.once('output'));
    p.assertLog();
  });

  itIntegrates.skip('waiting for source map failure', async ({ r }) => {
    const p = await r.launchUrlAndLoad('index.html');
    p.adapter.sourceContainer.setSourceMapTimeouts({
      load: 2000,
      resolveLocation: 0,
      output: 0,
      sourceMapMinPause: 0,
      sourceMapCumulativePause: 0,
    });
    await p.addScriptTag('browserify/bundle.js');
    p.dap.evaluate({ expression: `setTimeout(() => { window.throwError('error2')}, 0)` });
    await p.logger.logOutput(await p.dap.once('output'));
    p.assertLog();
  });

  itIntegrates('works with relative webpack sourcemaps (#479)', async ({ r }) => {
    const p = await r.launchUrl('webpack/relative-paths.html');

    await p.dap.setBreakpoints({
      source: { path: p.workspacePath('greet.js') },
      breakpoints: [{ line: 2, column: 1 }],
    });
    await p.dap.setBreakpoints({
      source: { path: p.workspacePath('web/webpack/farewell.js') },
      breakpoints: [{ line: 2, column: 1 }],
    });
    p.load();

    await waitForPause(p); // greet
    await waitForPause(p); // farewell
    p.assertLog();
  });

  itIntegrates('allows overrides for relative webpack paths (#479)', async ({ r }) => {
    const p = await r.launchUrl('webpack/relative-paths.html', {
      sourceMapPathOverrides: {
        'webpack:///./*': '${webRoot}/*',
        'webpack:///../*': '${webRoot}/was-nested/*',
      },
    });

    await p.dap.setBreakpoints({
      source: { path: p.workspacePath('web/was-nested/greet.js') },
      breakpoints: [{ line: 2, column: 1 }],
    });
    await p.dap.setBreakpoints({
      source: { path: p.workspacePath('web/webpack/farewell.js') },
      breakpoints: [{ line: 2, column: 1 }],
    });
    p.load();

    await waitForPause(p); // greet
    await waitForPause(p); // farewell
    p.assertLog();
  });

  itIntegrates('url and hash', async ({ r }) => {
    const p = await r.launchUrlAndLoad('index.html');

    p.cdp.Runtime.evaluate({ expression: 'a\n//# sourceURL=foo.js' });
    await dumpSource(p, await p.waitForSource('foo.js'), 'foo.js');

    // Same url, different content => different source.
    p.cdp.Runtime.evaluate({ expression: 'b\n//# sourceURL=foo.js' });
    await dumpSource(p, await p.waitForSource('foo.js'), 'foo.js');

    // Same url, same content => same sources.
    await p.cdp.Runtime.evaluate({ expression: 'a\n//# sourceURL=foo.js' });
    await p.cdp.Runtime.evaluate({ expression: 'b\n//# sourceURL=foo.js' });

    // Content matches => maps to file.
    p.addScriptTag('empty.js');
    await dumpSource(p, await p.waitForSource('empty.js'), 'empty.js');

    // Content does not match => debugger script.
    const path = p.workspacePath('web/empty2.js');
    p.adapter.sourceContainer.setFileContentOverrideForTest(path, '123');
    p.addScriptTag('empty2.js');
    await dumpSource(p, await p.waitForSource('empty2.js'), 'empty2.js');

    p.log(await p.dap.loadedSources({}), '\nLoaded sources: ');
    p.assertLog();
  });

  itIntegrates('allows module wrapper in node code', async ({ r }) => {
    const handle = await r.runScript(join(testWorkspace, 'moduleWrapper', 'index.js'));
    handle.load();
    const src = await handle.waitForSource('moduleWrapper/test.js');
    expect(src.source.sourceReference).to.equal(0);
  });

  itIntegrates('verifies content when enableContentValidation=true', async ({ r }) => {
    const handle = await r.runScript(join(testWorkspace, 'moduleWrapper', 'customWrapper.js'));
    handle.load();
    const src = await handle.waitForSource('moduleWrapper/test.js');
    expect(src.source.sourceReference).to.be.greaterThan(0);
  });

  itIntegrates('does not verify content when enableContentValidation=false', async ({ r }) => {
    const handle = await r.runScript(join(testWorkspace, 'moduleWrapper', 'customWrapper.js'), {
      enableContentValidation: false,
    });
    handle.load();
    const src = await handle.waitForSource('moduleWrapper/test.js');
    expect(src.source.sourceReference).to.equal(0);
  });

  itIntegrates('allows shebang in node code', async ({ r }) => {
    createFileTree(testFixturesDir, {
      index: 'require("./shebang-lf"); require("./shebang-crlf"); debugger;',
      'shebang-lf': '#!/bin/node\nconsole.log("hello world")',
      'shebang-crlf': '#!/bin/node\r\nconsole.log("hello world")',
    });

    const handle = await r.runScript(join(testFixturesDir, 'index'));
    handle.load();

    const lf = handle.waitForSource('shebang-lf');
    const crlf = handle.waitForSource('shebang-crlf');
    handle.log(await lf, undefined, []);
    handle.log(await crlf, undefined, []);
    handle.assertLog();
  });

  itIntegrates('removes any query from node paths (#529)', async ({ r }) => {
    const handle = await r.runScript(
      join(testWorkspace, 'simpleNode', 'simpleWebpackWithQuery.js'),
      {
        cwd: join(testWorkspace, 'simpleNode'),
      },
    );

    handle.load();
    handle.log(await handle.waitForSource('simpleWebpackWithQuery.ts'), undefined, []);
    handle.assertLog();
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

  itIntegrates('hash bom', async ({ r }) => {
    r.log(await hashBytes(utf8NoBOM));
    r.log(await hashBytes(utf8BOM));
    r.log(await hashBytes(utf16BigEndianBOM));
    r.log(await hashBytes(utf16LittleEndianBOM));
    r.assertLog();
  });

  itIntegrates('hash from file', async ({ r }) => {
    createFileTree(testFixturesDir, {
      utf8NoBOM,
      utf8BOM,
      utf16BigEndianBOM,
      utf16LittleEndianBOM,
    });

    r.log(await hashFile(join(testFixturesDir, 'utf8NoBOM')));
    r.log(await hashFile(join(testFixturesDir, 'utf8BOM')));
    r.log(await hashFile(join(testFixturesDir, 'utf16BigEndianBOM')));
    r.log(await hashFile(join(testFixturesDir, 'utf16LittleEndianBOM')));
    r.assertLog();
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

  itIntegrates('hash code points', async ({ r }) => {
    r.log(await hashBytes(multiByteCodePoints.toString('utf-8')));
    r.assertLog();
  });

  it('verifies files', async () => {
    createFileTree(testFixturesDir, {
      'test.js': 'hello world',
    });

    const result = await hashFile(join(testFixturesDir, 'test.js'));
    expect(result).to.equal('1ac3c2bf96f77c71394f85ba44fd90055bb72820');
  });

  it('verifies files when hash matches', async () => {
    createFileTree(testFixturesDir, {
      'test.js': 'hello world',
    });

    const result = await verifyFile(
      join(testFixturesDir, 'test.js'),
      '1ac3c2bf96f77c71394f85ba44fd90055bb72820',
      false,
    );
    expect(result).to.be.true;
  });

  it('verifies if wrapped in node module', async () => {
    createFileTree(testFixturesDir, {
      'test.js': 'hello world',
    });

    const result = await verifyFile(
      join(testFixturesDir, 'test.js'),
      '070b3b0d4612ebf3602b8110696d56564a4f1e73',
      true,
    );
    expect(result).to.be.true;
  });

  it('verify fails if not existent', async () => {
    const result = await verifyFile(
      join(testFixturesDir, 'test.js'),
      '1ac3c2bf96f77c71394f85ba44fd90055bb72820',
      false,
    );
    expect(result).to.be.false;
  });

  it('verify fails if hash wrong', async () => {
    createFileTree(testFixturesDir, {
      'test.js': 'hello world',
    });

    const result = await verifyFile(join(testFixturesDir, 'test.js'), 'potato', false);
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

    createFileTree(testFixturesDir, {
      'test.js': testFile,
    });

    const result = await verifyFile(
      join(testFixturesDir, 'test.js'),
      '04f6b56f40d4c63b243404afc8a7afba03d8e774',
      true,
    );
    expect(result).to.be.true;
  });

  describe('sourcemap error handling', () => {
    itIntegrates('logs initial parse errors', async ({ r }) => {
      const p = await r.launchUrlAndLoad('index.html');
      const output = p.dap.once('output', o => o.category === 'stderr');
      await p.evaluate(
        '//# sourceMappingURL=data:application/json;charset=utf-8;base64,ZGV2cw==\n',
      );
      await p.logger.logOutput(await output);
      p.assertLog();
    });

    itIntegrates('logs not found errors', async ({ r }) => {
      const p = await r.launchUrlAndLoad('index.html');
      const output = p.dap.once('output', o => o.category === 'stderr');
      await p.evaluate('//# sourceMappingURL=does-not-exist.js.map\n');
      await p.logger.logOutput(await output);
      p.assertLog();
    });

    itIntegrates('logs lazy parse errors', async ({ r }) => {
      const p = await r.launchUrlAndLoad('index.html');
      await p.dap.setBreakpoints({
        source: { path: p.workspacePath('web/eval1Source.js') },
        breakpoints: [{ line: 1, column: 1 }],
      });

      const output = p.dap.once('output', o => o.category === 'stderr');
      const contents = Buffer.from(
        JSON.stringify({
          version: 3,
          file: 'eval1.js',
          sourceRoot: '',
          sources: ['eval1Source.js'],
          mappings: '#,####;',
        }),
      ).toString('base64');
      const ev = p.evaluate(
        `//# sourceMappingURL=data:application/json;charset=utf-8;base64,${contents}\n`,
      );
      await p.logger.logOutput(await output);
      await ev;
      p.assertLog();
    });
  });
});
