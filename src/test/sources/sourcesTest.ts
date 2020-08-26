/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { join } from 'path';
import Dap from '../../dap/api';
import { ITestHandle, testFixturesDir, testWorkspace } from '../test';
import { createFileTree } from '../createFileTree';
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
