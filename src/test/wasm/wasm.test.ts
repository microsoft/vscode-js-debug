/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

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
});
