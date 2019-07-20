/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {TestP} from '../test';
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

  it('basic sources', async({p}: {p: TestP}) => {
    p.launchUrl('inlinescript.html');
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

  it('basic source map', async({p}: {p: TestP}) => {
    await p.launchUrl('index.html');
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

  it('waiting for source map', async ({ p }: { p: TestP }) => {
    await p.launchUrl('index.html');
    await p.addScriptTag('browserify/bundle.js');
    p.dap.evaluate({expression: `setTimeout(() => { window.throwError('error2')}, 0)`});
    await p.logger.logOutput(await p.dap.once('output'));
    p.assertLog();
  });

  it('waiting for source map failure', async ({ p }: { p: TestP }) => {
    await p.launchUrl('index.html');
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
}
