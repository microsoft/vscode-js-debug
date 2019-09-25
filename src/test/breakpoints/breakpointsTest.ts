// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {TestP} from '../test';
import Dap from '../../dap/api';

export function addTests(testRunner) {
  // @ts-ignore unused variables xit/fit.
  const {it, xit, fit, describe, fdescribe, xdescribe} = testRunner;

  async function waitForPause(p: TestP, cb?: () => Promise<void>) {
    const {threadId} = p.log(await p.dap.once('stopped'));
    await p.logger.logStackTrace(threadId);
    if (cb)
      await cb();
    return p.dap.continue({threadId});
  }

  describe('configure', () => {
    it('inline', async({p}: {p: TestP}) => {
      // Breakpoint in inline script set before launch.
      await p.initialize;
      const source: Dap.Source = {
        path: p.workspacePath('web/inlinescript.html')
      };
      await p.dap.setBreakpoints({source, breakpoints: [{line: 3, column: 2}]});
      p.launchUrl('inlinescript.html');
      await waitForPause(p);
      p.assertLog();
    });

    it('script', async({p}: {p: TestP}) => {
      // Breakpoint in separate script set before launch.
      await p.initialize;
      const source: Dap.Source = {
        path: p.workspacePath('web/script.js')
      };
      await p.dap.setBreakpoints({source, breakpoints: [{line: 9, column: 0}]});
      p.launchUrl('script.html');
      await waitForPause(p);
      await waitForPause(p);
      p.assertLog();
    });

    it('remove', async({p}: {p: TestP}) => {
      // Breakpoint in separate script set before launch, but then removed.
      await p.initialize;
      const source: Dap.Source = {
        path: p.workspacePath('web/script.js')
      };
      await p.dap.setBreakpoints({source, breakpoints: [{line: 2, column: 0}]});
      p.launchUrl('script.html');
      await waitForPause(p, async () => {
        await p.dap.setBreakpoints({source});
      });
      await waitForPause(p);
      p.cdp.Runtime.evaluate({expression: 'foo();\ndebugger;\n//# sourceURL=test.js'});
      await waitForPause(p);
      p.assertLog();
    });

    it('source map', async({p}: {p: TestP}) => {
      // Breakpoint in source mapped script set before launch.
      // Note: this only works in Chrome 76 or later and Node 12 or later, since it relies
      // on 'pause before executing script with source map' functionality in CDP.
      await p.initialize;
      const source: Dap.Source = {
        path: p.workspacePath('web/browserify/module2.ts')
      };
      await p.dap.setBreakpoints({source, breakpoints: [{line: 3}]});
      p.launchUrl('browserify/pause.html');
      await waitForPause(p);
      await waitForPause(p);
      p.assertLog();
    });

    it('source map predicted', async({p}: {p: TestP}) => {
      // Breakpoint in source mapped script set before launch use breakpoints predictor.
      await p.initialize;
      p.adapter.breakpointManager.setSourceMapPauseDisabledForTest(true);
      p.adapter.breakpointManager.setPredictorDisabledForTest(false);
      const source: Dap.Source = {
        path: p.workspacePath('web/browserify/module2.ts')
      };
      p.dap.setBreakpoints({source, breakpoints: [{line: 3}]});
      p.launchUrl('browserify/pause.html');
      await waitForPause(p);
      await waitForPause(p);
      p.assertLog();
    });
  });

  describe('launched', () => {
    it('inline', async({p}: {p: TestP}) => {
      // Breakpoint in inline script set after launch.
      p.launchUrl('inlinescriptpause.html');
      await waitForPause(p, async () => {
        const source: Dap.Source = {
          path: p.workspacePath('web/inlinescriptpause.html')
        };
        await p.dap.setBreakpoints({source, breakpoints: [{line: 6}]});
      });
      await waitForPause(p);
      p.assertLog();
    });

    it('script', async({p}: {p: TestP}) => {
      // Breakpoint in separate script set after launch.
      p.launchUrl('script.html');
      await waitForPause(p, async () => {
        const source: Dap.Source = {
          path: p.workspacePath('web/script.js')
        };
        await p.dap.setBreakpoints({source, breakpoints: [{line: 6}]});
      });
      await waitForPause(p);
      p.assertLog();
    });

    it('ref', async({p}: {p: TestP}) => {
      // Breakpoint in eval script set after launch using source reference.
      await p.launchUrl('index.html');
      p.cdp.Runtime.evaluate({expression: `
        function foo() {
          return 2;
        }
      `});
      const {source} = await p.waitForSource('eval');
      source.path = undefined;
      await p.dap.setBreakpoints({source, breakpoints: [{line: 3}]});
      p.evaluate('foo();');
      await waitForPause(p);
      p.assertLog();
    });

    it('remove', async({p}: {p: TestP}) => {
      // Breakpoint in eval script set after launch and immediately removed.
      await p.launchUrl('index.html');
      p.cdp.Runtime.evaluate({expression: `
        function foo() {
          return 2;
        }
      `});
      const {source} = await p.waitForSource('eval');
      source.path = undefined;
      await p.dap.setBreakpoints({source, breakpoints: [{line: 3}]});
      await p.dap.setBreakpoints({source});
      p.cdp.Runtime.evaluate({expression: 'foo();\ndebugger;\n//# sourceURL=test.js'});
      await waitForPause(p);
      p.assertLog();
    });

    it('overwrite', async({p}: {p: TestP}) => {
      // Breakpoint in eval script set after launch and immediately overwritten.
      await p.launchUrl('index.html');
      p.cdp.Runtime.evaluate({expression: `
        function foo() {
          var x = 3;
          return 2;
        }
      `});
      const {source} = await p.waitForSource('eval');
      source.path = undefined;
      await p.dap.setBreakpoints({source, breakpoints: [{line: 4}]});
      await p.dap.setBreakpoints({source, breakpoints: [{line: 3}]});
      p.cdp.Runtime.evaluate({expression: 'foo();\ndebugger;\n//# sourceURL=test.js'});
      await waitForPause(p);
      await waitForPause(p);
      p.assertLog();
    });

    it('source map', async({p}: {p: TestP}) => {
      // Breakpoint in source mapped script set after launch.
      await p.launchUrl('browserify/browserify.html');
      const source: Dap.Source = {
        path: p.workspacePath('web/browserify/module2.ts')
      };
      p.dap.setBreakpoints({source, breakpoints: [{line: 3}]});
      await p.dap.once('breakpoint', event => event.breakpoint.verified);
      p.cdp.Runtime.evaluate({expression: 'window.callBack(window.pause);\n//# sourceURL=test.js'});
      await waitForPause(p);
      await waitForPause(p);
      p.assertLog();
    });

    it('source map remove', async({p}: {p: TestP}) => {
      // Breakpoint in source mapped script set after launch and immediately removed.
      await p.launchUrl('browserify/browserify.html');
      const source: Dap.Source = {
        path: p.workspacePath('web/browserify/module2.ts')
      };
      await p.dap.setBreakpoints({source, breakpoints: [{line: 3}]});
      await p.dap.setBreakpoints({source, breakpoints: []});
      p.cdp.Runtime.evaluate({expression: 'window.callBack(window.pause);\n//# sourceURL=test.js'});
      await waitForPause(p);
      p.assertLog();
    });

    it('source map set compiled', async({p}: {p: TestP}) => {
      // Breakpoint in compiled script which has a source map should resolve
      // to the compiled script.
      await p.launchUrl('browserify/browserify.html');
      const source: Dap.Source = {
        path: p.workspacePath('web/browserify/bundle.js')
      };
      p.dap.setBreakpoints({source, breakpoints: [{line: 36}]});
      const resolved = await p.dap.once('breakpoint', event => !!event.breakpoint.verified);
      delete resolved.breakpoint.source!.sources;
      p.log(resolved, 'Breakpoint resolved: ');
      p.cdp.Runtime.evaluate({expression: 'window.callBack(window.pause);\n//# sourceURL=test.js'});

      // Should pause in 'bundle.js'.
      const {threadId} = p.log(await p.dap.once('stopped'));
      await p.logger.logStackTrace(threadId);
      p.dap.stepIn({threadId});

      // Should step into in 'bundle.js'.
      await waitForPause(p);
      p.assertLog();
    });

    it('source map set compiled 2', async({p}: {p: TestP}) => {
      // Breakpoint in compiled script which has a source map should resolve
      // to the compiled script.
      await p.launchUrl('browserify/browserify.html');
      const source: Dap.Source = {
        path: p.workspacePath('web/browserify/bundle.js')
      };
      p.dap.setBreakpoints({source, breakpoints: [{line: 36}]});
      const resolved = await p.dap.once('breakpoint', event => !!event.breakpoint.verified);
      delete resolved.breakpoint.source!.sources;
      p.log(resolved, 'Breakpoint resolved: ');
      p.cdp.Runtime.evaluate({expression: 'window.callBack(window.pause);\n//# sourceURL=test.js'});
      // Should pause in 'bundle.js'.
      await waitForPause(p);
      // Should resume and pause on 'debugger' in module1.ts.
      await waitForPause(p);
      p.assertLog();
    });
  });

  describe('logpoints', () => {
    it('basic', async({p}: {p: TestP}) => {
      await p.initialize;
      const source: Dap.Source = {
        path: p.workspacePath('web/logging.js')
      };
      await p.dap.setBreakpoints({source, breakpoints: [
        {line: 6, column: 0, logMessage: "123"},
        {line: 7, column: 0, logMessage: "{foo: 'bar'}"},
        {line: 8, column: 0, logMessage: "`bar`"},
        {line: 9, column: 0, logMessage: "`${bar}`"},
        {line: 10, column: 0, logMessage: "`${bar} ${foo}`"},
        {line: 11, column: 0, logMessage: "const a = bar + baz; a"},
        {line: 12, column: 0, logMessage: "const a = bar + baz; `a=${a}`"},
        {line: 13, column: 0, logMessage: "(x=>x+baz)(bar)"},
        {line: 14, column: 0, logMessage: "const b=(x=>x+baz)(bar); `b=${b}`"},
        {line: 15, column: 0, logMessage: "'hi'"},
      ]});
      p.launchUrl('logging.html');
      const outputs: Dap.OutputEventParams[] = [];
      for (let i = 0; i < 20; i++) {
        outputs.push(await p.dap.once('output'));
      }
      for (const o of outputs) {
        await p.logger.logOutput(o);
      }
      p.assertLog();
    });

    it('no double log', async({p}: {p: TestP}) => {
      await p.initialize;
      await p.launchUrl('logging.html');
      const source: Dap.Source = {
        path: p.workspacePath('web/logging.js')
      };
      await p.dap.setBreakpoints({source, breakpoints: [
        {line: 28, column: 0, logMessage: "window.logValue = (window.logValue || 0) + 1; 'LOG' + window.logValue"},
      ]});
      p.cdp.Runtime.evaluate({expression: "g(); console.log('DONE' + window.logValue)"});
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
    it('inner html', async({p}: {p: TestP}) => {
      // Custom breakpoint for innerHtml.
      await p.launchAndLoad('<div>text</div>');

      p.log('Not pausing on innerHTML');
      await p.evaluate(`document.querySelector('div').innerHTML = 'foo';`);

      p.log('Pausing on innerHTML');
      await p.adapter.enableCustomBreakpoints(['instrumentation:Element.setInnerHTML']);
      p.evaluate(`document.querySelector('div').innerHTML = 'bar';`);
      const event = p.log(await p.dap.once('stopped'));
      p.log(await p.dap.continue({threadId: event.threadId}));
      p.assertLog();
    });
  });
}
