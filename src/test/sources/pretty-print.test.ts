/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ITestHandle } from '../test';
import { itIntegrates } from '../testIntegrationUtils';

describe('pretty print sources', () => {
  async function waitAndStayPaused(p: ITestHandle) {
    const { threadId } = p.log(await p.dap.once('stopped'));
    await p.logger.logStackTrace(threadId);
    return () => p.dap.continue({ threadId });
  }

  itIntegrates('base', async ({ r }) => {
    const p = await r.launchUrl('pretty/pretty.html');
    const source = { path: p.workspacePath('web/pretty/ugly.js') };
    await p.dap.setBreakpoints({ source, breakpoints: [{ line: 5, column: 1 }] });
    p.load();

    await waitAndStayPaused(p);
    const res = p.dap.prettyPrintSource({ source });

    const gotSource = p.dap.once('loadedSource');
    const continued = p.dap.once('continued');
    const stopped = waitAndStayPaused(p);

    p.log(await continued);
    p.log(await gotSource);
    await res;
    (await stopped)();
    p.assertLog();
  });

  itIntegrates('steps in pretty', async ({ r }) => {
    const p = await r.launchUrl('pretty/pretty.html');
    const source = { path: p.workspacePath('web/pretty/ugly.js') };
    await p.dap.setBreakpoints({ source, breakpoints: [{ line: 5, column: 1 }] });
    p.load();

    await p.dap.once('stopped');
    p.dap.prettyPrintSource({ source });

    const { threadId } = p.log(await p.dap.once('stopped'));

    for (let i = 0; i < 4; i++) {
      p.log('\nstep');
      p.dap.next({ threadId });
      p.log(await Promise.all([p.dap.once('continued'), p.dap.once('stopped')]));
      await p.logger.logStackTrace(threadId);
    }

    p.assertLog();
  });

  itIntegrates('bps', async ({ r }) => {
    const p = await r.launchUrl('pretty/pretty.html');
    const source = { path: p.workspacePath('web/pretty/ugly.js') };
    await p.dap.setBreakpoints({
      source,
      breakpoints: [
        { line: 5, column: 1 },
        { line: 9, column: 1 },
      ],
    });
    p.load();

    p.log(await p.dap.once('breakpoint'));
    const { threadId } = p.log(await p.dap.once('stopped'));
    p.dap.prettyPrintSource({ source });
    const pretty = p.dap.once('loadedSource');

    // should adjust all BPs to new file
    const bp1Prom = p.dap.once('breakpoint');
    const bp2Prom = p.dap.once('breakpoint');
    const bp1 = p.log(await bp1Prom).breakpoint;
    const bp2 = p.log(await bp2Prom).breakpoint;

    // should set a breakpoint in pretty source:
    p.log(
      await p.dap.setBreakpoints({
        source: (await pretty).source,
        breakpoints: [
          { line: 17, column: 1 },
          { line: bp1.line, column: bp1.column },
          { line: bp2.line, column: bp2.column },
        ],
      }),
    );

    // should hit breakpoints:
    for (let i = 0; i < 2; i++) {
      p.log('\ncontinue');
      p.dap.continue({ threadId });
      p.log(await Promise.all([p.dap.once('continued'), p.dap.once('stopped')]));
      await p.logger.logStackTrace(threadId);
    }

    p.assertLog();
  });
});
