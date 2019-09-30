// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {TestRoot, TestP} from '../test';
import Dap from '../../dap/api';

export function addTests(testRunner) {
  // @ts-ignore unused variables xit/fit.
  const {it, xit, fit} = testRunner;

  async function dumpSource(p: TestP, event: Dap.LoadedSourceEventParams, name: string) {
    p.log('\nSource event for ' + name);
    p.log(event);
    const content = await p.dap.source({sourceReference: event.source.sourceReference!, source: {
      path: event.source.path,
      sourceReference: event.source.sourceReference,
    }});
    p.log(`${content.mimeType}`);
    p.log('---------');
    p.log(content.content);
    p.log('---------');
  }

  it('basic sources', async({r}: {r: TestRoot}) => {
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

  it('updated content', async({r}: {r: TestRoot}) => {
    const p = await r.launchUrlAndLoad('index.html');
    p.cdp.Runtime.evaluate({expression: 'content1//# sourceURL=test.js'});
    await dumpSource(p, await p.waitForSource('test'), 'test.js');
    p.cdp.Runtime.evaluate({expression: 'content2//# sourceURL=test.js'});
    await dumpSource(p, await p.waitForSource('test'), 'test.js updated');
    p.log(await p.dap.loadedSources({}), '\nLoaded sources: ');
    p.assertLog();
  });

  it('basic source map', async({r}: {r: TestRoot}) => {
    const p = await r.launchUrlAndLoad('index.html');
    p.addScriptTag('browserify/bundle.js');
    const sources = await Promise.all([
      p.waitForSource('index.ts'),
      p.waitForSource('module1.ts'),
      p.waitForSource('module2.ts'),
    ]);
    for (const source of sources)
      await dumpSource(p, source, '');
    p.assertLog();
  });

  it('waiting for source map', async ({ r }: { r: TestRoot }) => {
    const p = await r.launchUrlAndLoad('index.html');
    await p.addScriptTag('browserify/bundle.js');
    p.dap.evaluate({expression: `setTimeout(() => { window.throwError('error2')}, 0)`});
    await p.logger.logOutput(await p.dap.once('output'));
    p.assertLog();
  });

  it('waiting for source map failure', async ({ r }: { r: TestRoot }) => {
    const p = await r.launchUrlAndLoad('index.html');
    p.adapter.sourceContainer.setSourceMapTimeouts({
      load: 2000,
      resolveLocation: 0,
      output: 0,
      scriptPaused: 0,
    });
    await p.addScriptTag('browserify/bundle.js');
    p.dap.evaluate({expression: `setTimeout(() => { window.throwError('error2')}, 0)`});
    await p.logger.logOutput(await p.dap.once('output'));
    p.assertLog();
  });

  it('url and hash', async({r}: {r: TestRoot}) => {
    const p = await r.launchUrlAndLoad('index.html');

    p.cdp.Runtime.evaluate({expression: 'a\n//# sourceURL=foo.js'});
    await dumpSource(p, await p.waitForSource('foo.js'), 'foo.js');

    // Same url, different content => different source.
    p.cdp.Runtime.evaluate({expression: 'b\n//# sourceURL=foo.js'});
    await dumpSource(p, await p.waitForSource('foo.js'), 'foo.js');

    // Same url, same content => same sources.
    await p.cdp.Runtime.evaluate({expression: 'a\n//# sourceURL=foo.js'});
    await p.cdp.Runtime.evaluate({expression: 'b\n//# sourceURL=foo.js'});

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
}
