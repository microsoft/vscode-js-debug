/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ITestHandle } from '../test';
import Dap from '../../dap/api';
import { itIntegrates } from '../testIntegrationUtils';
import { DebugType } from '../../common/contributionUtils';

describe('webview breakpoints', () => {
  async function waitForPause(p: ITestHandle, cb?: (threadId: string) => Promise<void>) {
    const { threadId } = p.log(await p.dap.once('stopped'));
    await p.logger.logStackTrace(threadId);
    if (cb) await cb(threadId);
    return p.dap.continue({ threadId });
  }

  itIntegrates('launched script', async ({ r, context }) => {
    context.timeout(15 * 1000);

    // Breakpoint in separate script set after launch.
    const p = await r.launchUrl('script.html', {
      type: DebugType.Edge,
      runtimeExecutable: r.workspacePath('webview/win/WebView2Sample.exe'),
      useWebView: true,
      // WebView2Sample.exe launches about:blank
      urlFilter: 'about:blank',
    });
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
});
