/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { createFileTree, testFixturesDir, testWorkspace, ITestHandle } from '../test';
import Dap from '../../dap/api';
import { hashBytes, hashFile, verifyFile } from '../../common/hash';
import { itIntegrates, waitForPause } from '../testIntegrationUtils';
import { join } from 'path';
import { expect } from 'chai';

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
      scriptPaused: 0,
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
    handle.log(await handle.waitForSource('moduleWrapper/index.js'), undefined, []);
    handle.assertLog();
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

  /**
   *  different encodings for the same string: "\"1111111111111111111111111111111111111111111\""
   */
  // prettier-ignore
  const utf8NoBOM = Buffer.from([0x22, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31,
    0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31,
    0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31,
    0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31,
    0x31, 0x22 ]);
  // prettier-ignore
  const utf8BOM = Buffer.from([
    0xEF, 0xBB, 0xBF, 0x22, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31,
    0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31,
    0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31,
    0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x22 ]);
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
