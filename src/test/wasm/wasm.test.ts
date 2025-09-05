/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Dap from '../../dap/api';
import { TestRoot } from '../test';
import { itIntegrates } from '../testIntegrationUtils';

describe('webassembly', () => {
  itIntegrates('basic stepping and breakpoints', async ({ r }) => {
    const p = await r.launchUrl('wasm/hello.html');
    await p.dap.setBreakpoints({
      source: {
        path: p.workspacePath('web/wasm/hello.html'),
      },
      breakpoints: [{ line: 14 }],
    });

    p.load();

    {
      const { threadId } = p.log(await p.dap.once('stopped'));
      await p.dap.stepIn({ threadId });
    }

    {
      const { threadId } = p.log(await p.dap.once('stopped'), 'stopped event');
      const stacktrace = await p.logger.logStackTrace(threadId);
      const content = await p.dap.source({
        sourceReference: stacktrace[0].source!.sourceReference!,
        source: stacktrace[0].source,
      });

      p.log(content.mimeType, 'source mime type');
      p.log(content.content, 'source content');

      await p.dap.setBreakpoints({
        source: stacktrace[0].source!,
        breakpoints: [{ line: 10 }],
      });

      await p.dap.continue({ threadId });
    }

    {
      const { threadId } = p.log(await p.dap.once('stopped'), 'breakpoint stopped event');
      await p.logger.logStackTrace(threadId);
    }

    p.assertLog();
  });

  describe('dwarf', () => {
    const prepare = async (
      r: TestRoot,
      context: Mocha.Context,
      file: string,
      bp: Dap.SetBreakpointsParams,
    ) => {
      // starting the dwarf debugger can be pretty slow, I observed up to 40
      // seconds in one case :(
      // context.timeout(120_000);

      const p = await r.launchUrlAndLoad(`dwarf/${file}.html`);
      bp.source.path = p.workspacePath(bp.source.path!);
      await p.dap.setBreakpoints(bp);

      await p.dap.once('breakpoint', bp => bp.breakpoint.verified);
      p.cdp.Page.reload({});
      // wait for the reload to start:
      await p.dap.once('loadedSource', e => e.reason === 'removed');
      return p;
    };

    itIntegrates('can break immediately', async ({ r }) => {
      const p = await r.launchUrl(`dwarf/fibonacci.html`);

      // Note: we need the extra stop because we depend on the eval running to add the instrumentation for wasm
      // https://github.com/microsoft/vscode-js-debug/blob/16b601cb24260e1a58c2c09c9456ccb5bbef0013/src/adapter/threads.ts#L939

      await p.dap.setBreakpoints({
        source: { path: p.workspacePath('web/dwarf/fibonacci.html') },
        breakpoints: [{ line: 1221 }],
      });
      await p.dap.setBreakpoints({
        source: { path: p.workspacePath('web/dwarf/fibonacci.c') },
        breakpoints: [{ line: 6 }],
      });
      p.load();

      const prePause = await p.dap.once('stopped');
      await p.dap.continue({ threadId: prePause.threadId! });

      const { threadId } = p.log(await p.dap.once('stopped'));
      await p.logger.logStackTrace(threadId, 2);

      r.assertLog();
    });

    itIntegrates('scopes and variables', async ({ r, context }) => {
      const p = await prepare(r, context, 'fibonacci', {
        source: { path: 'web/dwarf/fibonacci.c' },
        breakpoints: [{ line: 6 }],
      });

      const { threadId } = p.log(await p.dap.once('stopped'));
      await p.logger.logStackTrace(threadId, 2);

      r.assertLog();
    });

    itIntegrates('basic stepping', async ({ r, context }) => {
      const p = await prepare(r, context, 'fibonacci', {
        source: { path: 'web/dwarf/fibonacci.c' },
        breakpoints: [{ line: 6 }],
      });

      {
        const { threadId } = p.log(await p.dap.once('stopped'));
        await p.dap.setBreakpoints({
          source: { path: p.workspacePath('web/dwarf/fibonacci.c') },
          breakpoints: [],
        });

        p.dap.next({ threadId });
      }

      {
        const { threadId } = p.log(await p.dap.once('stopped'));
        await p.logger.logStackTrace(threadId);
        p.dap.stepOut({ threadId });
      }

      {
        const { threadId } = p.log(await p.dap.once('stopped'));
        await p.logger.logStackTrace(threadId);
      }

      r.assertLog();
    });

    itIntegrates('inline breakpoints set at all call sites', async ({ r, context }) => {
      const p = await prepare(r, context, 'diverse-inlining', {
        source: {
          path: 'web/dwarf/diverse-inlining.h',
        },
        breakpoints: [{ line: 2 }],
      });

      {
        const { threadId } = p.log(await p.dap.once('stopped'));
        await p.logger.logStackTrace(threadId);
        p.dap.continue({ threadId });
      }

      {
        const { threadId } = p.log(await p.dap.once('stopped'));
        await p.logger.logStackTrace(threadId, 2);
        p.dap.continue({ threadId });
      }

      r.assertLog();
    });

    itIntegrates('inline function stepping 1', async ({ r, context }) => {
      const p = await prepare(r, context, 'diverse-inlining', {
        source: {
          path: 'web/dwarf/diverse-inlining-main.c',
        },
        breakpoints: [{ line: 7 }],
      });

      const steps = [
        // stopped at `argc = foo(argc);`
        'stepIn',
        // stopped at `INLINE static int`
        'stepOut',
        // stopped at `argc = foo(argc);`,
        'next',

        // stopped at `argc = bar(argc);`
        'stepIn',
        // stopped at `int bar(int x) {`
        'stepIn',
        // stopped at `x = x + 1;`
        'stepIn',
      ] as const;

      for (const step of steps) {
        const { threadId } = p.log(await p.dap.once('stopped'));
        await p.logger.logStackTrace(threadId);
        p.dap[step]({ threadId });
        p.log(`---- ${step} ----`);
      }

      const { threadId } = p.log(await p.dap.once('stopped'));
      await p.logger.logStackTrace(threadId);

      r.assertLog();
    });

    itIntegrates('inline function stepping 2', async ({ r, context }) => {
      const p = await prepare(r, context, 'diverse-inlining', {
        source: {
          path: 'web/dwarf/diverse-inlining-extern.c',
        },
        breakpoints: [{ line: 5 }],
      });

      // stopped at return foo()
      {
        const { threadId } = p.log(await p.dap.once('stopped'));
        await p.logger.logStackTrace(threadId);
        p.dap.next({ threadId });
      }

      // should be back in main, stepped over inline range
      {
        const { threadId } = p.log(await p.dap.once('stopped'));
        await p.logger.logStackTrace(threadId);
      }

      r.assertLog();
    });

    itIntegrates('does lldb evaluation', async ({ r, context }) => {
      const p = await prepare(r, context, 'fibonacci', {
        source: { path: 'web/dwarf/fibonacci.c' },
        breakpoints: [{ line: 6 }],
      });

      const { threadId } = p.log(await p.dap.once('stopped'));
      const { id: frameId } = (await p.dap.stackTrace({ threadId })).stackFrames[0];

      await p.logger.evaluateAndLog(`n`, { params: { frameId } });
      await p.logger.evaluateAndLog(`a`, { params: { frameId } });
      await p.logger.evaluateAndLog(`a + n * 2`, { params: { frameId } });

      r.assertLog();
    });

    itIntegrates('does lldb evaluation for structs', async ({ r, context }) => {
      const p = await prepare(r, context, 'c-with-struct', {
        source: { path: 'web/dwarf/c-with-struct.c' },
        breakpoints: [{ line: 11 }],
      });

      const { threadId } = p.log(await p.dap.once('stopped'));
      const { id: frameId } = (await p.dap.stackTrace({ threadId })).stackFrames[0];

      await p.logger.evaluateAndLog('(data_t*)data', { params: { frameId }, depth: 3 });

      r.assertLog();
    });
  });
});
