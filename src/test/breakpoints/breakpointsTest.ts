/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { testWorkspace, ITestHandle, createFileTree, TestRoot, TestP } from '../test';
import Dap from '../../dap/api';
import { itIntegrates, waitForPause } from '../testIntegrationUtils';
import { expect } from 'chai';
import { join } from 'path';
import { readfile } from '../../common/fsUtils';
import { forceForwardSlashes } from '../../common/pathUtils';
import del = require('del');

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
      await waitForPause(p, async () => {
        await p.dap.setBreakpoints({ source });
      });
      await waitForPause(p);
      p.cdp.Runtime.evaluate({ expression: 'foo();\ndebugger;\n//# sourceURL=test.js' });
      await waitForPause(p);
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

      after(() =>
        del([`${forceForwardSlashes(cwd)}/**`], {
          force: true /* delete outside cwd */,
        }),
      );

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
      p.adapter.breakpointManager.setSourceMapPauseDisabledForTest();
      p.adapter.breakpointManager.setPredictorDisabledForTest(false);
      const source: Dap.Source = {
        path: p.workspacePath('web/browserify/module2.ts'),
      };
      p.dap.setBreakpoints({ source, breakpoints: [{ line: 3 }] });
      p.load();
      await waitForPause(p);
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
      p.cdp.Runtime.evaluate({
        expression: `
        function foo() {
          return 2;
        }
      `,
      });
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
      p.cdp.Runtime.evaluate({
        expression: `
        function foo() {
          return 2;
        }
      `,
      });
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
      p.cdp.Runtime.evaluate({
        expression: `
        function foo() {
          var x = 3;
          return 2;
        }
      `,
      });
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
      const p = await r.launchUrlAndLoad('browserify/browserify.html');
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
      const p = await r.launchUrlAndLoad('browserify/browserify.html');
      const source: Dap.Source = {
        path: p.workspacePath('web/browserify/bundle.js'),
      };
      const resolved = await p.dap.setBreakpoints({ source, breakpoints: [{ line: 36 }] });
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
      const p = await r.launchUrlAndLoad('browserify/browserify.html');
      const source: Dap.Source = {
        path: p.workspacePath('web/browserify/bundle.js'),
      };
      const resolved = await p.dap.setBreakpoints({ source, breakpoints: [{ line: 36 }] });
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
  });

  describe('logpoints', () => {
    itIntegrates('basic', async ({ r }) => {
      const p = await r.launchUrl('logging.html');
      const source: Dap.Source = {
        path: p.workspacePath('web/logging.js'),
      };
      const breakpoints = [
        { line: 6, column: 0, logMessage: '123' },
        { line: 7, column: 0, logMessage: "{{foo: 'bar'}}" },
        { line: 8, column: 0, logMessage: '{foo}' },
        { line: 9, column: 0, logMessage: 'foo {foo} bar' },
        { line: 10, column: 0, logMessage: 'foo {bar + baz}' },
        { line: 11, column: 0, logMessage: '{const a = bar + baz; a}' },
        { line: 12, column: 0, logMessage: '{(x=>x+baz)(bar)}' },
        { line: 13, column: 0, logMessage: '{throw new Error("oof")}' },
        { line: 14, column: 0, logMessage: "{'hi'}" },
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
      await p.dap.enableCustomBreakpoints({ ids: ['instrumentation:Element.setInnerHTML'] });
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
        breakpoints: [{ line: 5, column: 1 }],
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
        breakpoints: [{ line: 5, column: 1 }],
      });

      handle.load();
      const { threadId } = await handle.dap.once('stopped');
      handle.log(
        await handle.dap.setBreakpoints({
          source: { path: join(cwd, 'double.ts') },
          breakpoints: [{ line: 15, column: 1 }],
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
        breakpoints: [{ line: 5, column: 1 }],
      });

      handle.load();
      await waitForPause(handle);
      handle.assertLog({ substring: true });
    });

    itIntegrates('does not adjust already correct', async ({ r }) => {
      await r.initialize;

      const cwd = join(testWorkspace, 'tsNode');
      const handle = await r.runScript(join(cwd, 'index.js'));
      await handle.dap.setBreakpoints({
        source: { path: join(cwd, 'double.ts') },
        breakpoints: [{ line: 15, column: 1 }],
      });

      handle.load();
      await waitForPause(handle);
      handle.assertLog({ substring: true });
    });
  });

  itIntegrates('restart frame', async ({ r }) => {
    const p = await r.launchUrl('restart.html');
    const source: Dap.Source = {
      path: p.workspacePath('web/restart.js'),
    };
    await p.dap.setBreakpoints({ source, breakpoints: [{ line: 6, column: 0 }] });
    p.load();
    const { threadId } = p.log(await p.dap.once('stopped'));
    const stack = await p.logger.logStackTrace(threadId);
    p.dap.restartFrame({ frameId: stack[0].id });

    await waitForPause(p);
    p.assertLog();
  });

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
        }),
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
        }),
      );
    });
  });

  describe('hit count', () => {
    const doTest = async (r: TestRoot, run: (p: TestP, source: Dap.Source) => Promise<void>) => {
      const p = await r.launchUrlAndLoad('index.html');
      p.cdp.Runtime.evaluate({
        expression: `
        function foo() {
          for (let i = 0; i < 10; i++) {
            console.log(i);
            console.log(i);
            console.log(i);
          }
        }
      `,
      });
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
          await p.dap.setBreakpoints({ source, breakpoints: [{ line: 4, hitCondition: '=5' }] }),
        );
        const evaluate = p.evaluate('foo();');
        await waitForHit(p);
        await evaluate;
      });
    });

    itIntegrates('can change after set', async ({ r }) => {
      await doTest(r, async (p, source) => {
        r.log(
          await p.dap.setBreakpoints({ source, breakpoints: [{ line: 4, hitCondition: '=5' }] }),
        );
        r.log(
          await p.dap.setBreakpoints({ source, breakpoints: [{ line: 4, hitCondition: '=8' }] }),
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
});
