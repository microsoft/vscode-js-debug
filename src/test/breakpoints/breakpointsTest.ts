/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { promises as fs } from 'fs';
import { join } from 'path';
import { readfile } from '../../common/fsUtils';
import { forceForwardSlashes } from '../../common/pathUtils';
import { absolutePathToFileUrlWithDetection } from '../../common/urlUtils';
import Dap from '../../dap/api';
import { createFileTree } from '../createFileTree';
import { removeNodeInternalsStackLines } from '../goldenText';
import { ITestHandle, testFixturesDir, TestP, TestRoot, testWorkspace } from '../test';
import { itIntegrates, waitForPause } from '../testIntegrationUtils';

describe('breakpoints', () => {
  describe('configure', () => {
    itIntegrates('inline', async ({ r }) => {
      // Breakpoint in inline script set before launch.
      const p = await r.launchUrl('inlinescript.html');
      const source: Dap.Source = {
        path: p.workspacePath('web/inlinescript.html'),
      };
      await p.dap.setBreakpoints({ source, breakpoints: [{ line: 3, column: 2 }] });
      p.load();
      await waitForPause(p);
      p.assertLog();
    });

    itIntegrates('script', async ({ r }) => {
      // Breakpoint in separate script set before launch.
      const p = await r.launchUrl('script.html');
      const source: Dap.Source = {
        path: p.workspacePath('web/script.js'),
      };
      await p.dap.setBreakpoints({ source, breakpoints: [{ line: 9, column: 0 }] });
      p.load();
      await waitForPause(p);
      await waitForPause(p);
      p.assertLog();
    });

    itIntegrates('query params', async ({ r }) => {
      // Breakpoint in separate script set before launch.
      const p = await r.launchUrl('script-with-query-param.html');
      const source: Dap.Source = {
        path: p.workspacePath('web/script.js'),
      };
      await p.dap.setBreakpoints({ source, breakpoints: [{ line: 9, column: 0 }] });
      p.load();
      await waitForPause(p);
      await waitForPause(p);
      p.assertLog();
    });

    itIntegrates('remove', async ({ r }) => {
      // Breakpoint in separate script set before launch, but then removed.
      const p = await r.launchUrl('script.html');
      const source: Dap.Source = {
        path: p.workspacePath('web/script.js'),
      };
      await p.dap.setBreakpoints({ source, breakpoints: [{ line: 2, column: 0 }] });
      p.load();

      let bpChanged: Dap.BreakpointEventParams | undefined;
      await waitForPause(p, async () => {
        // should not update bp after it's removed, #1406
        p.dap.once('breakpoint').then(bp => (bpChanged = bp));
        await p.dap.setBreakpoints({ source });
      });
      await waitForPause(p);
      p.cdp.Runtime.evaluate({ expression: 'foo();\ndebugger;\n//# sourceURL=test.js' });
      await waitForPause(p);
      expect(bpChanged).to.be.undefined;
      p.assertLog();
    });

    itIntegrates('source map', async ({ r }) => {
      // Breakpoint in source mapped script set before launch.
      // Note: this only works in Chrome 76 or later and Node 12 or later, since it relies
      // on 'pause before executing script with source map' functionality in CDP.
      const p = await r.launchUrl('browserify/pause.html');
      const source: Dap.Source = {
        path: p.workspacePath('web/browserify/module2.ts'),
      };
      await p.dap.setBreakpoints({ source, breakpoints: [{ line: 3 }] });
      p.load();
      await waitForPause(p);
      await waitForPause(p);
      p.assertLog();
    });

    itIntegrates('absolute paths in source maps', async ({ r }) => {
      // Some builds create absolute disk paths in sourcemaps. This test
      // swaps relative paths with absolute paths in the browserify test
      // and makes sure it works identically.
      const cwd = r.workspacePath('web/tmp');

      after(async () => {
        await fs.rm(cwd, { recursive: true, force: true });
      });

      createFileTree(cwd, {
        'pause.js': await readfile(r.workspacePath('web/browserify/pause.js')),
        'pause.html': await readfile(r.workspacePath('web/browserify/pause.html')),
        'pause.js.map': (await readfile(r.workspacePath('web/browserify/pause.js.map'))).replace(
          /"([a-z0-9]+.ts)"/g,
          `"${forceForwardSlashes(r.workspacePath('web/browserify'))}/$1"`,
        ),
      });

      const p = await r.launchUrl('tmp/pause.html');
      const source: Dap.Source = {
        path: p.workspacePath('web/browserify/module2.ts'),
      };

      await p.dap.setBreakpoints({ source, breakpoints: [{ line: 3 }] });
      p.load();
      await waitForPause(p);
      await waitForPause(p);
      p.assertLog();
    });

    itIntegrates('source map predicted', async ({ r }) => {
      // Breakpoint in source mapped script set before launch use breakpoints predictor.
      const p = await r.launchUrl('browserify/pause.html');
      p.adapter.breakpointManager.setPredictorDisabledForTest(false);
      const source: Dap.Source = {
        path: p.workspacePath('web/browserify/module2.ts'),
      };
      await p.dap.setBreakpoints({ source, breakpoints: [{ line: 3 }] });
      p.load();
      await waitForPause(p);
      await waitForPause(p);
      p.assertLog();
    });

    itIntegrates("source map that's path mapped", async ({ r }) => {
      const cwd = r.workspacePath('web/tmp');

      after(async () => {
        await fs.rm(cwd, { recursive: true, force: true });
      });

      createFileTree(cwd, {
        'app.ts': await readfile(r.workspacePath('web/pathMapped/app.ts')),
        'app.js': (await readfile(r.workspacePath('web/pathMapped/app.js'))).replace(
          'app.js.map',
          'mappedPath/app.js.map',
        ),
        'index.html': await readfile(r.workspacePath('web/pathMapped/index.html')),
        mappedDir: {
          'app.js.map': await readfile(r.workspacePath('web/pathMapped/app.js.map')),
        },
      });

      const p = await r.launchUrl('tmp/index.html', {
        pathMapping: {
          '/mappedPath/': '${workspaceFolder}/web/tmp/mappedDir/',
        },
      });
      const source: Dap.Source = {
        path: p.workspacePath('web/tmp/app.ts'),
      };

      await p.dap.setBreakpoints({ source, breakpoints: [{ line: 2 }] });
      p.load();
      await waitForPause(p);
      p.assertLog();
    });
  });

  describe('launched', () => {
    itIntegrates('inline', async ({ r }) => {
      // Breakpoint in inline script set after launch.
      const p = await r.launchUrl('inlinescriptpause.html');
      p.load();
      await waitForPause(p, async () => {
        const source: Dap.Source = {
          path: p.workspacePath('web/inlinescriptpause.html'),
        };
        await p.dap.setBreakpoints({ source, breakpoints: [{ line: 6 }] });
      });
      await waitForPause(p);
      p.assertLog();
    });

    itIntegrates('script', async ({ r }) => {
      // Breakpoint in separate script set after launch.
      const p = await r.launchUrl('script.html');
      p.load();
      await waitForPause(p, async () => {
        const source: Dap.Source = {
          path: p.workspacePath('web/script.js'),
        };
        await p.dap.setBreakpoints({ source, breakpoints: [{ line: 6 }] });
      });
      await waitForPause(p);
      p.assertLog();
    });

    itIntegrates('ref', async ({ r }) => {
      // Breakpoint in eval script set after launch using source reference.
      const p = await r.launchUrlAndLoad('index.html');
      p.evaluate(`
      function foo() {
        return 2;
      }
    `);
      const { source } = await p.waitForSource('eval');
      source.path = undefined;
      await p.dap.setBreakpoints({ source, breakpoints: [{ line: 3 }] });
      const evaluation = p.evaluate('foo();');
      await waitForPause(p);
      await evaluation;
      p.assertLog();
    });

    itIntegrates('remove', async ({ r }) => {
      // Breakpoint in eval script set after launch and immediately removed.
      const p = await r.launchUrlAndLoad('index.html');
      p.evaluate(`
        function foo() {
          return 2;
        }
      `);
      const { source } = await p.waitForSource('eval');
      source.path = undefined;
      await p.dap.setBreakpoints({ source, breakpoints: [{ line: 3 }] });
      await p.dap.setBreakpoints({ source });
      p.cdp.Runtime.evaluate({ expression: 'foo();\ndebugger;\n//# sourceURL=test.js' });
      await waitForPause(p);
      p.assertLog();
    });

    itIntegrates('overwrite', async ({ r }) => {
      // Breakpoint in eval script set after launch and immediately overwritten.
      const p = await r.launchUrlAndLoad('index.html');
      p.evaluate(`
        function foo() {
          var x = 3;
          return 2;
        }
      `);
      const { source } = await p.waitForSource('eval');
      source.path = undefined;
      await p.dap.setBreakpoints({ source, breakpoints: [{ line: 4 }] });
      await p.dap.setBreakpoints({ source, breakpoints: [{ line: 3 }] });
      p.cdp.Runtime.evaluate({ expression: 'foo();\ndebugger;\n//# sourceURL=test.js' });
      await waitForPause(p);
      await waitForPause(p);
      p.assertLog();
    });

    itIntegrates('source map', async ({ r }) => {
      // Breakpoint in source mapped script set after launch.
      const p = await r.launchUrl('browserify/browserify.html');
      const sourceP = p.waitForSource('module2.ts');
      await p.load();
      await sourceP;

      const source: Dap.Source = {
        path: p.workspacePath('web/browserify/module2.ts'),
      };
      const resolved = await p.dap.setBreakpoints({ source, breakpoints: [{ line: 3 }] });
      expect(resolved.breakpoints[0].verified).to.be.true;
      p.cdp.Runtime.evaluate({
        expression: 'window.callBack(window.pause);\n//# sourceURL=test.js',
      });
      await waitForPause(p);
      await waitForPause(p);
      p.assertLog();
    });

    itIntegrates('source map remove', async ({ r }) => {
      // Breakpoint in source mapped script set after launch and immediately removed.
      const p = await r.launchUrlAndLoad('browserify/browserify.html');
      const source: Dap.Source = {
        path: p.workspacePath('web/browserify/module2.ts'),
      };
      await p.dap.setBreakpoints({ source, breakpoints: [{ line: 3 }] });
      await p.dap.setBreakpoints({ source, breakpoints: [] });
      p.cdp.Runtime.evaluate({
        expression: 'window.callBack(window.pause);\n//# sourceURL=test.js',
      });
      await waitForPause(p);
      p.assertLog();
    });

    // See #109
    itIntegrates('source map set compiled', async ({ r }) => {
      // Breakpoint in compiled script which has a source map should resolve
      // to the compiled script.
      const p = await r.launchUrl('browserify/browserify.html');
      p.load();
      await p.waitForSource('bundle.js');
      const resolved = await p.dap.setBreakpoints({
        source: { path: p.workspacePath('web/browserify/bundle.js') },
        breakpoints: [{ line: 36 }],
      });

      delete resolved.breakpoints[0].source!.sources;
      p.log(resolved.breakpoints[0], 'Breakpoint resolved: ');
      p.cdp.Runtime.evaluate({
        expression: 'window.callBack(window.pause);\n//# sourceURL=test.js',
      });

      // Should pause in 'bundle.js'.
      const { threadId } = p.log(await p.dap.once('stopped'));
      await p.logger.logStackTrace(threadId);
      p.dap.stepIn({ threadId });

      // Should step into in 'bundle.js'.
      await waitForPause(p);
      p.assertLog();
    });

    // See #109
    itIntegrates('source map set compiled 2', async ({ r }) => {
      // Breakpoint in compiled script which has a source map should resolve
      // to the compiled script.
      const p = await r.launchUrl('browserify/browserify.html');
      p.load();
      await p.waitForSource('bundle.js');

      const resolved = await p.dap.setBreakpoints({
        source: { path: p.workspacePath('web/browserify/bundle.js') },
        breakpoints: [{ line: 36 }],
      });
      delete resolved.breakpoints[0].source!.sources;
      p.log(resolved.breakpoints[0], 'Breakpoint resolved: ');
      p.cdp.Runtime.evaluate({
        expression: 'window.callBack(window.pause);\n//# sourceURL=test.js',
      });
      // Should pause in 'bundle.js'.
      await waitForPause(p);
      // Should resume and pause on 'debugger' in module1.ts.
      await waitForPause(p);
      p.assertLog();
    });

    itIntegrates('sets breakpoints in sourcemapped node_modules', async ({ r }) => {
      await r.initialize;

      const cwd = join(testWorkspace, 'nodeModuleBreakpoint');
      const handle = await r.runScript(join(cwd, 'index.js'), {
        outFiles: [`${cwd}/**/*.js`],
        env: { MODULE: '@c4312/foo' },
        resolveSourceMapLocations: null,
      });
      await handle.dap.setBreakpoints({
        source: { path: join(cwd, 'node_modules', '@c4312', 'foo', 'src', 'index.ts') },
        breakpoints: [{ line: 2, column: 1 }],
      });

      handle.load();
      await waitForPause(handle);
      handle.assertLog({ substring: true });
    });

    itIntegrates(
      'sets breakpoints in sourcemapped node_modules with absolute root',
      async ({ r }) => {
        await r.initialize;

        const cwd = join(testWorkspace, 'nodeModuleBreakpoint');
        const handle = await r.runScript(join(cwd, 'index.js'), {
          outFiles: [`${cwd}/**/*.js`],
          env: { MODULE: '@c4312/absolute-sourceroot' },
          resolveSourceMapLocations: null,
        });
        await handle.dap.setBreakpoints({
          source: {
            path: join(cwd, 'node_modules', '@c4312', 'absolute-sourceroot', 'src', 'index.ts'),
          },
          breakpoints: [{ line: 2, column: 1 }],
        });

        handle.load();
        await waitForPause(handle);
        handle.assertLog({ substring: true });
      },
    );

    itIntegrates('absolute path in nested module', async ({ r }) => {
      await r.initialize;

      const cwd = join(testWorkspace, 'nestedAbsRoot');
      const handle = await r.runScript(join(cwd, 'index.js'));
      await handle.dap.setBreakpoints({
        source: { path: join(cwd, 'test.js') },
        breakpoints: [{ line: 1, column: 1 }],
      });

      handle.load();
      await waitForPause(handle);
      handle.assertLog({ substring: true });
    });
  });

  describe('logpoints', () => {
    itIntegrates('basic', async ({ r }) => {
      const p = await r.launchUrl('logging.html');
      const source: Dap.Source = {
        path: p.workspacePath('web/logging.js'),
      };
      const breakpoints = [
        { line: 6, column: 0, logMessage: '123' },
        { line: 7, column: 0, logMessage: "{({foo: 'bar'})}" },
        { line: 8, column: 0, logMessage: '{foo}' },
        { line: 9, column: 0, logMessage: 'foo {foo} bar' },
        { line: 10, column: 0, logMessage: 'foo {bar + baz}' },
        { line: 11, column: 0, logMessage: '{const a = bar + baz; a}' },
        { line: 12, column: 0, logMessage: '{(x=>x+baz)(bar)}' },
        { line: 13, column: 0, logMessage: '{throw new Error("oof")}' },
        { line: 14, column: 0, logMessage: "{'hi'}" },
        { line: 15, column: 0, logMessage: "{{foo: 'bar'}}" },
        { line: 16, column: 0, logMessage: '{{f}}' },
      ];
      await p.dap.setBreakpoints({
        source,
        breakpoints,
      });
      p.load();
      const outputs: Dap.OutputEventParams[] = [];
      for (let i = 0; i < breakpoints.length; i++) {
        outputs.push(await p.dap.once('output'));
      }
      for (const o of outputs) {
        await p.logger.logOutput(o);
      }
      p.assertLog();
    });

    itIntegrates('callstack', async ({ r }) => {
      const p = await r.launchUrl('logging.html');
      await p.dap.setBreakpoints({
        source: { path: p.workspacePath('web/logging.js') },
        breakpoints: [{ line: 6, column: 0, logMessage: '123' }],
      });
      p.load();
      p.log(await p.dap.once('output'));
      p.assertLog();
    });

    itIntegrates('returnValue', async ({ r }) => {
      const p = await r.launchUrl('logging.html');
      await p.dap.setBreakpoints({
        source: { path: p.workspacePath('web/logging.js') },
        breakpoints: [{ line: 32, column: 100, logMessage: 'doubled: {$returnValue * 2}' }],
      });
      p.load();
      await p.logger.logOutput(await p.dap.once('output'));
      p.assertLog();
    });

    itIntegrates('no double log', async ({ r }) => {
      const p = await r.launchUrlAndLoad('logging.html');
      const source: Dap.Source = {
        path: p.workspacePath('web/logging.js'),
      };
      await p.dap.setBreakpoints({
        source,
        breakpoints: [
          {
            line: 28,
            column: 0,
            logMessage: "{'LOG' + (window.logValue = (window.logValue || 0) + 1)}",
          },
        ],
      });
      p.cdp.Runtime.evaluate({ expression: "g(); console.log('DONE' + window.logValue)" });
      const outputs: Dap.OutputEventParams[] = [];
      for (let i = 0; i < 2; i++) {
        outputs.push(await p.dap.once('output'));
      }
      for (const o of outputs) {
        await p.logger.logOutput(o);
      }
      p.assertLog();
    });
  });

  describe('hit condition', () => {
    async function waitForPauseAndLogI(p: ITestHandle) {
      await waitForPause(p, async () => {
        await p.logger.evaluateAndLog('i');
      });
    }

    itIntegrates('exact', async ({ r }) => {
      const p = await r.launchUrl('condition.html');
      const source: Dap.Source = {
        path: p.workspacePath('web/condition.js'),
      };
      await p.dap.setBreakpoints({
        source,
        breakpoints: [{ line: 2, column: 0, hitCondition: '==2' }],
      });
      p.load();
      await waitForPauseAndLogI(p);
      await waitForPause(p);
      p.assertLog();
    });

    itIntegrates('less than', async ({ r }) => {
      // Breakpoint in separate script set before launch.
      const p = await r.launchUrl('condition.html');
      const source: Dap.Source = {
        path: p.workspacePath('web/condition.js'),
      };
      await p.dap.setBreakpoints({
        source,
        breakpoints: [{ line: 2, column: 0, hitCondition: '<3' }],
      });
      p.load();

      await waitForPauseAndLogI(p);
      await waitForPauseAndLogI(p);
      await waitForPause(p);
      p.assertLog();
    });

    itIntegrates('greater than', async ({ r }) => {
      // Breakpoint in separate script set before launch.
      const p = await r.launchUrl('condition.html');
      const source: Dap.Source = {
        path: p.workspacePath('web/condition.js'),
      };
      await p.dap.setBreakpoints({
        source,
        breakpoints: [{ line: 2, column: 0, hitCondition: '>3' }],
      });
      p.load();

      await waitForPauseAndLogI(p);
      await waitForPauseAndLogI(p);
      p.assertLog();
    });

    itIntegrates('invalid', async ({ r }) => {
      // Breakpoint in separate script set before launch.
      const p = await r.launchUrl('condition.html');
      const source: Dap.Source = {
        path: p.workspacePath('web/condition.js'),
      };
      p.dap.on('output', output => {
        if (output.category === 'stderr') {
          p.logger.logOutput(output);
        }
      });
      await p.dap.setBreakpoints({
        source,
        breakpoints: [{ line: 2, column: 0, hitCondition: 'abc' }],
      });
      p.load();
      await waitForPause(p); // falls through to debugger statement
      p.assertLog();
    });
  });

  describe('condition', () => {
    async function waitForPauseAndLogI(p: ITestHandle) {
      await waitForPause(p, async () => {
        await p.logger.evaluateAndLog('i');
      });
    }

    itIntegrates('basic', async ({ r }) => {
      const p = await r.launchUrl('condition.html');
      const source: Dap.Source = {
        path: p.workspacePath('web/condition.js'),
      };
      await p.dap.setBreakpoints({
        source,
        breakpoints: [{ line: 2, column: 0, condition: 'i==2' }],
      });
      p.load();
      await waitForPauseAndLogI(p);
      await waitForPause(p);
      p.assertLog();
    });

    itIntegrates('ignores error by default', async ({ r }) => {
      const p = await r.launchUrl('condition.html');
      await p.dap.setBreakpoints({
        source: { path: p.workspacePath('web/condition.js') },
        breakpoints: [{ line: 2, column: 0, condition: '(() => { throw "oh no" })()' }],
      });
      const output = p.dap.once('output');
      p.load();
      await waitForPause(p);
      await r.log(await output); // an error message
      p.assertLog();
    });

    itIntegrates('pauses on error', async ({ r }) => {
      const p = await r.launchUrl('condition.html', { __breakOnConditionalError: true });
      await p.dap.setBreakpoints({
        source: { path: p.workspacePath('web/condition.js') },
        breakpoints: [{ line: 2, column: 0, condition: '(() => { throw "oh no" })()' }],
      });
      p.load();
      const output = p.dap.once('output');
      await waitForPause(p);
      p.logger.logOutput(await output);
      p.assertLog();
    });

    itIntegrates('ignores bp with invalid condition', async ({ r }) => {
      // Breakpoint in separate script set before launch.
      const p = await r.launchUrl('condition.html');
      const output = p.dap.once('output');
      const source: Dap.Source = {
        path: p.workspacePath('web/condition.js'),
      };
      await p.dap.setBreakpoints({
        source,
        breakpoints: [{ line: 2, column: 0, condition: ')(}{][.&' }],
      });
      p.load();

      await r.log(await output); // an error message
      await waitForPause(p); // falls through to debugger statement
      p.assertLog();
    });
  });

  describe('custom', () => {
    itIntegrates('inner html', async ({ r }) => {
      // Custom breakpoint for innerHtml.
      const p = await r.launchAndLoad('<div>text</div>');

      p.log('Not pausing on innerHTML');
      await p.evaluate(`document.querySelector('div').innerHTML = 'foo';`);

      p.log('Pausing on innerHTML');
      await p.dap.setCustomBreakpoints({
        ids: ['instrumentation:Element.setInnerHTML'],
        xhr: [],
      });
      p.evaluate(`document.querySelector('div').innerHTML = 'bar';`);
      const event = p.log(await p.dap.once('stopped'));
      p.log(await p.dap.continue({ threadId: event.threadId }));
      p.assertLog();
    });
  });

  describe('first line', () => {
    itIntegrates('breaks if requested', async ({ r }) => {
      await r.initialize;

      const cwd = join(testWorkspace, 'simpleNode');
      const handle = await r.runScript(join(cwd, 'index.js'));
      await handle.dap.setBreakpoints({
        source: { path: join(cwd, 'index.js') },
        breakpoints: [{ line: 1, column: 1 }],
      });

      handle.load();
      await waitForPause(handle);
      handle.assertLog({ substring: true });
    });

    itIntegrates('does not break if not requested', async ({ r }) => {
      await r.initialize;

      const cwd = join(testWorkspace, 'simpleNode');
      const handle = await r.runScript(join(cwd, 'index.js'));
      await handle.dap.setBreakpoints({
        source: { path: join(cwd, 'index.js') },
        breakpoints: [{ line: 2, column: 1 }],
      });

      handle.load();
      await waitForPause(handle);
      handle.assertLog({ substring: true });
    });
  });

  describe('hot-transpiled', () => {
    itIntegrates('breaks on first line', async ({ r }) => {
      await r.initialize;

      const cwd = join(testWorkspace, 'tsNode');
      const handle = await r.runScript(join(cwd, 'index.js'));
      await handle.dap.setBreakpoints({
        source: { path: join(cwd, 'double.ts') },
        breakpoints: [{ line: 1, column: 1 }],
      });

      handle.load();
      await waitForPause(handle);
      handle.assertLog({ substring: true });
    });

    itIntegrates('user defined bp on first line', async ({ r }) => {
      // The scenario is if a user-defined breakpoint is hit on the first line
      // of the script, even if in the transpiled code it should have been
      // on a different line. This tests that we run a hit-check after source maps.
      await r.initialize;

      const cwd = join(testWorkspace, 'tsNode');
      const handle = await r.runScript(join(cwd, 'index.js'));
      await handle.dap.setBreakpoints({
        source: { path: join(cwd, 'log.ts') },
        breakpoints: [{ line: 2, column: 1 }],
      });

      handle.load();
      await waitForPause(handle);
      handle.assertLog({ substring: true });
    });

    itIntegrates('adjusts breakpoints', async ({ r }) => {
      await r.initialize;

      const cwd = join(testWorkspace, 'tsNode');
      const handle = await r.runScript(join(cwd, 'index.js'));
      await handle.dap.setBreakpoints({
        source: { path: join(cwd, 'double.ts') },
        breakpoints: [{ line: 7, column: 1 }],
      });

      handle.load();
      await waitForPause(handle);
      handle.assertLog({ substring: true });
    });

    itIntegrates('adjusts breakpoints after already running (#524)', async ({ r }) => {
      await r.initialize;

      const cwd = join(testWorkspace, 'tsNode');
      const handle = await r.runScript(join(cwd, 'index.js'));
      await handle.dap.setBreakpoints({
        source: { path: join(cwd, 'double.ts') },
        breakpoints: [{ line: 7, column: 1 }],
      });

      handle.load();
      const { threadId } = await handle.dap.once('stopped');
      handle.log(
        await handle.dap.setBreakpoints({
          source: { path: join(cwd, 'double.ts') },
          breakpoints: [{ line: 17, column: 1 }],
        }),
      );

      handle.dap.continue({ threadId: threadId! });
      await waitForPause(handle);
      handle.assertLog({ substring: true });
    });

    itIntegrates('works in remote workspaces', async ({ r }) => {
      await r.initialize;

      const cwd = join(testWorkspace, 'tsNode');
      const handle = await r.runScriptAsRemote(join(cwd, 'index.js'));
      await handle.dap.setBreakpoints({
        source: { path: join(cwd, 'double.ts') },
        breakpoints: [{ line: 7, column: 1 }],
      });

      handle.load();
      await waitForPause(handle);
      handle.assertLog({ substring: true });
    });

    itIntegrates('avoids double pathmapping (#1617)', async ({ r }) => {
      // specifically check that the pathmapping is not used multiple times
      // if the source path is an apparent child of the remote path. Requires
      // the file in the sourcemap to be relative.
      createFileTree(testFixturesDir, {
        src: {
          'double.js': "console.log('hello world');",
        },
        'double.js': [
          "/*'Object.<anonymous>':function(module,exports,require,__dzrname,__fzlename,jest*/console.log('hello world');",
          '//# sourceMappingURL=data:application/json;charset=utf-8;base64,'
          + Buffer.from(
            JSON.stringify({
              version: 3,
              names: ['console', 'log'],
              sources: ['double.js'],
              sourcesContent: ["console.log('hello world');\n"],
              mappings: 'AAAAA,OAAO,CAACC,GAAG,CAAC,aAAa,CAAC',
            }),
          ).toString('base64'),
        ],
      });

      const handle = await r.runScript('double.js', {
        localRoot: join(testFixturesDir, 'src'),
        remoteRoot: testFixturesDir,
      });

      await handle.dap.setBreakpoints({
        source: { path: join(testFixturesDir, 'src', 'double.js') },
        breakpoints: [{ line: 1, column: 1 }],
      });

      handle.load();
      await waitForPause(handle);
      r.assertLog({ substring: true });
    });

    itIntegrates('does not adjust already correct', async ({ r }) => {
      await r.initialize;

      const cwd = join(testWorkspace, 'tsNode');
      const handle = await r.runScript(join(cwd, 'index.js'));
      await handle.dap.setBreakpoints({
        source: { path: join(cwd, 'matching-line.ts') },
        breakpoints: [{ line: 3, column: 1 }],
      });

      handle.load();
      await waitForPause(handle);
      handle.assertLog({ substring: true });
    });
  });

  // Todo: this feature has been removed from Chrome: https://chromium.googlesource.com/v8/v8/+/93f85699e22df958618206dbf94a790cf0bad8c4
  // it's still supported in the debugger for now, but eventually as Node updates we'll drop support
  // itIntegrates('restart frame', async ({ r }) => {
  //   const p = await r.launchUrl('restart.html');
  //   const source: Dap.Source = {
  //     path: p.workspacePath('web/restart.js'),
  //   };
  //   await p.dap.setBreakpoints({ source, breakpoints: [{ line: 6, column: 0 }] });
  //   p.load();
  //   const { threadId } = p.log(await p.dap.once('stopped'));
  //   const stack = await p.logger.logStackTrace(threadId);
  //   p.dap.restartFrame({ frameId: stack[0].id });

  //   await waitForPause(p);
  //   p.assertLog();
  // });

  describe('lazy async stack', () => {
    itIntegrates('sets stack on pause', async ({ r }) => {
      // First debugger; hit will have no async stack, the second (after turning on) will
      const p = await r.launchUrl('asyncStack.html', {
        showAsyncStacks: { onceBreakpointResolved: 32 },
      });
      p.load();
      await waitForPause(p);
      await waitForPause(p);
      p.assertLog();
    });

    itIntegrates('sets eagerly on bp', async ({ r }) => {
      // Both debugger; hits will have async stacks since we had a resolved BP
      const p = await r.launchUrl('asyncStack.html', {
        showAsyncStacks: { onceBreakpointResolved: 32 },
      });
      const source: Dap.Source = {
        path: p.workspacePath('web/asyncStack.js'),
      };
      await p.dap.setBreakpoints({ source, breakpoints: [{ line: 5, column: 1 }] });
      p.load();
      await waitForPause(p);
      await waitForPause(p);
      p.assertLog();
    });
  });

  itIntegrates('gets correct line number with babel code (#407)', async ({ r }) => {
    await r.initialize;
    const cwd = join(testWorkspace, 'babelLineNumbers');

    const handle = await r.runScript(join(cwd, `compiled.js`));
    await handle.dap.setBreakpoints({
      source: { path: join(cwd, 'compiled.js') },
      breakpoints: [{ line: 1 }],
    });

    await handle.dap.setBreakpoints({
      source: { path: join(cwd, 'app.tsx') },
      breakpoints: [{ line: 2 }],
    });

    handle.load();

    const { threadId } = handle.log(await handle.dap.once('stopped'));
    await handle.dap.continue({ threadId });
    await waitForPause(handle);
    handle.assertLog({ substring: true });
  });

  itIntegrates('vue projects', async ({ r }) => {
    const p = await r.launchUrl('vue/index.html');
    await p.dap.setBreakpoints({
      source: { path: p.workspacePath('web/src/App.vue') },
      breakpoints: [{ line: 9, column: 1 }],
    });
    p.load();

    const { threadId } = p.log(await p.dap.once('stopped'));
    await p.logger.logStackTrace(threadId);
    p.dap.stepIn({ threadId });
    await waitForPause(p);
    p.assertLog();
  });

  describe('breakpoint placement', () => {
    const cwd = join(testWorkspace, 'sourceMapLocations');

    describe('first function stmt', () => {
      ['tsc', 'babel'].forEach(tcase =>
        itIntegrates(tcase, async ({ r }) => {
          await r.initialize;

          const handle = await r.runScript(join(cwd, `${tcase}.js`));
          await handle.dap.setBreakpoints({
            source: { path: join(cwd, 'test.ts') },
            breakpoints: [{ line: 4, column: 1 }],
          });

          handle.load();
          await waitForPause(handle);
          handle.assertLog({ substring: true });
        })
      );
    });

    describe('end function stmt', () => {
      ['tsc', 'babel'].forEach(tcase =>
        itIntegrates(tcase, async ({ r }) => {
          await r.initialize;

          const handle = await r.runScript(join(cwd, `${tcase}.js`));
          await handle.dap.setBreakpoints({
            source: { path: join(cwd, 'test.ts') },
            breakpoints: [{ line: 6, column: 1 }],
          });

          handle.load();
          await waitForPause(handle);
          handle.assertLog({ substring: true });
        })
      );
    });
  });

  describe('hit count', () => {
    const doTest = async (r: TestRoot, run: (p: TestP, source: Dap.Source) => Promise<void>) => {
      const p = await r.launchUrlAndLoad('index.html');
      p.evaluate(`
        function foo() {
          for (let i = 0; i < 10; i++) {
            console.log(i);
            console.log(i);
            console.log(i);
          }
        }
      `);
      const { source } = await p.waitForSource('eval');
      source.path = undefined;
      await run(p, source);
      p.assertLog();
    };

    const waitForHit = async (p: TestP) => {
      const { threadId: pageThreadId } = await p.dap.once('stopped');
      const { id: pageFrameId } = (
        await p.dap.stackTrace({
          threadId: pageThreadId!,
        })
      ).stackFrames[0];
      await p.logger.logEvaluateResult(
        await p.dap.evaluate({ expression: 'i', frameId: pageFrameId }),
      );
      return p.dap.continue({ threadId: pageThreadId! });
    };

    itIntegrates('works for valid', async ({ r }) => {
      await doTest(r, async (p, source) => {
        r.log(
          await p.dap.setBreakpoints({
            source,
            breakpoints: [{ line: 4, hitCondition: '=5' }],
          }),
        );
        const evaluate = p.evaluate('foo();');
        await waitForHit(p);
        await evaluate;
      });
    });

    itIntegrates('implies equal (#1698)', async ({ r }) => {
      await doTest(r, async (p, source) => {
        r.log(
          await p.dap.setBreakpoints({ source, breakpoints: [{ line: 4, hitCondition: '5' }] }),
        );
        const evaluate = p.evaluate('foo();');
        await waitForHit(p);
        await evaluate;
      });
    });

    itIntegrates('can change after set', async ({ r }) => {
      await doTest(r, async (p, source) => {
        r.log(
          await p.dap.setBreakpoints({
            source,
            breakpoints: [{ line: 4, hitCondition: '=5' }],
          }),
        );
        r.log(
          await p.dap.setBreakpoints({
            source,
            breakpoints: [{ line: 4, hitCondition: '=8' }],
          }),
        );
        const evaluate = p.evaluate('foo();');
        await waitForHit(p);
        await evaluate;
      });
    });

    itIntegrates('does not validate or hit invalid breakpoint', async ({ r }) => {
      await doTest(r, async (p, source) => {
        const output = p.dap.once('output');
        r.log(
          await p.dap.setBreakpoints({
            source,
            breakpoints: [{ line: 4, hitCondition: 'potato' }],
          }),
        );
        await r.log(await output); // an error message
        await p.evaluate('foo();'); // should complete without getting paused
      });
    });
  });

  itIntegrates(
    'user defined bp on first line with stop on entry on .ts file reports as breakpoint',
    async ({ r }) => {
      await r.initialize;

      const cwd = join(testWorkspace, 'tsNodeApp');
      const handle = await r.runScript(join(cwd, 'app.ts'), {
        stopOnEntry: true,
        smartStep: false,
      });
      await handle.dap.setBreakpoints({
        source: { path: join(cwd, 'app.ts') },
        breakpoints: [{ line: 1, column: 1 }],
      });

      handle.load();
      await waitForPause(handle);
      handle.assertLog({ substring: true });
    },
  );

  itIntegrates('stop on entry on .ts file reports as entry', async ({ r }) => {
    await r.initialize;

    const cwd = join(testWorkspace, 'tsNodeApp');
    const handle = await r.runScript(join(cwd, 'app.ts'), {
      stopOnEntry: true,
      smartStep: false,
    });
    await handle.dap.setBreakpoints({
      source: { path: join(cwd, 'app.tsx') },
      breakpoints: [{ line: 2, column: 1 }],
    });

    handle.load();
    await waitForPause(handle);
    handle.assertLog({ substring: true });
  });

  itIntegrates(
    'resolves sourcemaps in paths containing glob patterns (vscode#166400)',
    async ({ r }) => {
      await r.initialize;

      const cwd = join(testWorkspace, 'glob(chars)');
      const handle = await r.runScript(join(cwd, 'app.ts'), {
        stopOnEntry: true,
        smartStep: false,
        outFiles: [`${cwd}/**/*.js`],
        resolveSourceMapLocations: [`${cwd}/**/*.js`],
      });
      await handle.dap.setBreakpoints({
        source: { path: join(cwd, 'app.ts') },
        breakpoints: [{ line: 2, column: 1 }],
      });

      handle.load();
      await waitForPause(handle);
      handle.assertLog({ substring: true });
    },
  );

  itIntegrates('reevaluates breakpoints when new sources come in (#600)', async ({ r }) => {
    const p = await r.launchUrl('unique-refresh?v=1');
    p.load();

    // to trigger the bug, must wait for the source otherwise it will set by path and not url:
    const { source } = await p.waitForSource('hello.js');

    p.dap.setBreakpoints({
      source,
      breakpoints: [{ line: 2, column: 1 }],
    });

    await waitForPause(p);
    p.cdp.Page.navigate({ url: r.buildUrl('unique-refresh?v=2') });
    await waitForPause(p);
    p.assertLog();
  });

  itIntegrates('can step in when first line of code is function', async ({ r }) => {
    createFileTree(testFixturesDir, {
      'test.js': ['function double(x) {', '  x *= 2;', '  return x;', '}', 'double(2)'],
    });

    const handle = await r.runScript('test.js');
    await handle.dap.setBreakpoints({
      source: { path: join(testFixturesDir, 'test.js') },
      breakpoints: [{ line: 5, column: 0 }],
    });

    handle.load();
    const { threadId } = handle.log(await handle.dap.once('stopped'));
    await handle.logger.logStackTrace(threadId);
    handle.dap.stepIn({ threadId });
    await waitForPause(handle);

    handle.assertLog({ process: removeNodeInternalsStackLines });
  });

  itIntegrates('normalizes webpack nul byte (#1080)', async ({ r }) => {
    const cwd = join(testWorkspace, 'webpackNulByte');
    const handle = await r.runScript(join(cwd, 'build/greeter.js'), { cwd });
    await handle.dap.setBreakpoints({
      source: { path: join(cwd, 'src/#hello/world.ts') },
      breakpoints: [{ line: 1, column: 0 }],
    });

    handle.load();
    await waitForPause(handle);
    handle.assertLog({ substring: true });
  });

  itIntegrates('excludes callers', async ({ r }) => {
    const p = await r.launchAndLoad('blank');

    p.dap.evaluate({
      expression: `
        function foo() {
          bar();
        }

        function baz() {
          bar();
        }

        function bar() {
          debugger;
        }

        foo();
        baz();
        foo();
        baz();
      `,
    });

    await waitForPause(p, async threadId => {
      const {
        stackFrames: [foo, bar],
      } = await p.dap.stackTrace({ threadId });
      await p.dap.setExcludedCallers({
        callers: [
          {
            caller: { line: bar.line, column: bar.column, source: bar.source! },
            target: { line: foo.line, column: foo.column, source: foo.source! },
          },
        ],
      });
    });
    await waitForPause(p); // should hit baz
    await waitForPause(p); // should skip foo and hit baz again
    p.assertLog();
  });

  itIntegrates('ignores source url query string (#1225)', async ({ r }) => {
    const cwd = join(testWorkspace, 'sourceQueryString');
    const handle = await r.runScript(join(cwd, 'output.js'), { cwd });
    handle.load();
    await waitForPause(handle);
    handle.assertLog({ substring: true });
  });

  itIntegrates('toggles source map stepping', async ({ r }) => {
    const p = await r.launchUrl('basic.html');
    await p.dap.setBreakpoints({
      source: {
        path: p.workspacePath('web/basic.ts'),
      },
      breakpoints: [{ line: 12 }],
    });

    p.load();

    // sourcemaps enabled:
    {
      const bp = p.dap.once('breakpoint');
      const { threadId } = p.log(await p.dap.once('stopped'));
      await r.log(await bp, 'Initial breakpoint resolution');
      await p.logger.logStackTrace(threadId);
    }

    // disables and moves breakpoint and pause location:
    p.dap.setSourceMapStepping({ enabled: false });
    const bp = p.dap.once('breakpoint');
    const { threadId } = p.log(await p.dap.once('stopped'));
    await r.log(await bp, 'Demapped breakpoint');
    await p.logger.logStackTrace(threadId);

    // steps in demapped code when enabled
    await p.dap.stepIn({ threadId });
    await waitForPause(p);
    p.assertLog();
  });

  itIntegrates('prefers file uris to url (#1598)', async ({ r }) => {
    const file = join(testWorkspace, 'web/script.html');
    const p = await r.launchUrl('script.html', { file });
    r._launchUrl = absolutePathToFileUrlWithDetection(file); // fix so navigation is right

    const source: Dap.Source = {
      path: p.workspacePath('web/script.js'),
    };
    await p.dap.setBreakpoints({ source, breakpoints: [{ line: 9, column: 0 }] });
    p.load();
    await waitForPause(p);
    await waitForPause(p);
    p.assertLog();
  });

  itIntegrates('stepInTargets', async ({ r }) => {
    const p = await r.launchUrl('stepInTargets.html');
    const src = p.waitForSource('stepInTargets.js');
    await p.load();

    await p.dap.setBreakpoints({
      source: (await src).source,
      breakpoints: [
        { line: 4, column: 1 },
        { line: 5, column: 1 },
      ],
    });

    const evaluation = p.dap.evaluate({ expression: 'doTest()' });

    // line 3
    {
      const { threadId: threadId1 } = p.log(await p.dap.once('stopped'));
      const { stackFrames } = await p.dap.stackTrace({ threadId: threadId1 });

      const { targets } = p.log(
        await p.dap.stepInTargets({ frameId: stackFrames[0].id }),
        'stepInTargets line 3',
      );

      p.log(
        await p.dap.stepIn({ threadId: threadId1, targetId: targets[0].id }),
        'step in new Foo()',
      );
      await waitForPause(p);
    }

    // line 4
    {
      const { threadId: threadId1 } = p.log(await p.dap.once('stopped'));
      const { stackFrames } = await p.dap.stackTrace({ threadId: threadId1 });

      const { targets } = p.log(
        await p.dap.stepInTargets({ frameId: stackFrames[0].id }),
        'stepInTargets line 4',
      );

      p.log(
        await p.dap.stepIn({ threadId: threadId1, targetId: targets[2].id }),
        'step in new Foo().bar()',
      );
      await waitForPause(p);
    }

    await evaluation;
    p.assertLog();
  });

  itIntegrates(
    'does not interrupt stepOver with instrumentation breakpoint (#1556)',
    async ({ r }) => {
      async function pauseAndNext(p: ITestHandle) {
        const { threadId } = p.log(await p.dap.once('stopped'));
        await p.logger.logStackTrace(threadId);
        return p.dap.next({ threadId });
      }

      const p = await r.launchAndLoad(`
        <script>
          function test() {
            debugger;
            f=eval(\`
              (function (a, b) {
                c = a + b;
                return c;
              });
              //# sourceURL=foo.js
              //# sourceMappingURL=foo.js.map
            \`);
            f(1, 2);
          }
        </script>`);

      const evaluate = p.evaluate('test()');

      await pauseAndNext(p); // debugger statement
      await pauseAndNext(p); // f=eval(...
      await waitForPause(p); // should now be on f(1, 2)

      await evaluate;
      p.assertLog();
    },
  );

  itIntegrates(
    'does not interrupt stepIn with instrumentation breakpoint (#1665)',
    async ({ r }) => {
      const p = await r.launchAndLoad(`
        <script>
          function test() {
            debugger;
            f=eval(\`
              (function (a, b) {
                c = a + b;
                return c;
              });
              //# sourceURL=foo.js
              //# sourceMappingURL=foo.js.map
            \`);
            f(1, 2);
          }
        </script>`);

      const evaluate = p.evaluate('test()');

      const a = p.log(await p.dap.once('stopped')); // debugger statement
      await p.logger.logStackTrace(a.threadId);
      await p.dap.stepIn({ threadId: a.threadId });

      const b = p.log(await p.dap.once('stopped')); // f=eval(...
      await p.logger.logStackTrace(b.threadId);
      await p.dap.stepIn({ threadId: b.threadId });

      await waitForPause(p); // should now be on (function (a, b)

      await evaluate;
      p.assertLog();
    },
  );

  itIntegrates('deals with removed execution contexts (#1582)', async ({ r }) => {
    const p = await r.launchUrlAndLoad('iframe-1582/index.html');

    const source: Dap.Source = {
      path: p.workspacePath('web/iframe-1582/inner.js'),
    };
    p.dap.setBreakpoints({ source, breakpoints: [{ line: 3 }] });
    await waitForPause(p, async () => {
      await p.dap.evaluate({
        expression: 'document.getElementsByTagName("IFRAME")[0].src += ""',
        context: 'repl',
      });
    });

    await waitForPause(p, async () => {
      await p.dap.setBreakpoints({ source, breakpoints: [] });
    });

    // re-sets the breakpoints in the new script
    p.dap.setBreakpoints({ source, breakpoints: [{ line: 3 }] });

    await waitForPause(p);
    p.assertLog();
  });

  itIntegrates('sets file uri breakpoints predictably (#1748)', async ({ r }) => {
    createFileTree(testFixturesDir, {
      'pages/main.html': '<script src="../scripts/hello.js"></script>',
      'scripts/hello.js': 'console.log(42)',
    });

    const mainFile = join(testFixturesDir, 'pages/main.html');
    const p = await r.launchUrl(absolutePathToFileUrlWithDetection(mainFile), {
      url: undefined,
      file: mainFile,
    });

    const source: Dap.Source = { path: join(testFixturesDir, 'scripts/hello.js') };
    await p.dap.setBreakpoints({ source, breakpoints: [{ line: 1 }] });
    p.load();

    await waitForPause(p);
    p.assertLog();
  });
});
