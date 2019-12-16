/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { testWorkspace, ITestHandle } from '../test';
import Dap from '../../dap/api';
import { itIntegrates } from '../testIntegrationUtils';
import { expect } from 'chai';
import { join } from 'path';

describe('breakpoints', () => {
  async function waitForPause(p: ITestHandle, cb?: () => Promise<void>) {
    const { threadId } = p.log(await p.dap.once('stopped'));
    await p.logger.logStackTrace(threadId);
    if (cb) await cb();
    return p.dap.continue({ threadId });
  }

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
      p.evaluate('foo();');
      await waitForPause(p);
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
      });
      await handle.dap.setBreakpoints({
        source: { path: join(cwd, 'node_modules', '@c4312', 'foo', 'src', 'index.ts') },
        breakpoints: [{ line: 2, column: 1 }],
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
      await p.dap.setBreakpoints({
        source,
        breakpoints: [
          { line: 6, column: 0, logMessage: '123' },
          { line: 7, column: 0, logMessage: "{foo: 'bar'}" },
          { line: 8, column: 0, logMessage: '`bar`' },
          { line: 9, column: 0, logMessage: '`${bar}`' },
          { line: 10, column: 0, logMessage: '`${bar} ${foo}`' },
          { line: 11, column: 0, logMessage: 'const a = bar + baz; a' },
          { line: 12, column: 0, logMessage: 'const a = bar + baz; `a=${a}`' },
          { line: 13, column: 0, logMessage: '(x=>x+baz)(bar)' },
          { line: 14, column: 0, logMessage: 'const b=(x=>x+baz)(bar); `b=${b}`' },
          { line: 15, column: 0, logMessage: "'hi'" },
        ],
      });
      p.load();
      const outputs: Dap.OutputEventParams[] = [];
      for (let i = 0; i < 20; i++) {
        outputs.push(await p.dap.once('output'));
      }
      for (const o of outputs) {
        await p.logger.logOutput(o);
      }
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
            logMessage: "window.logValue = (window.logValue || 0) + 1; 'LOG' + window.logValue",
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
});
