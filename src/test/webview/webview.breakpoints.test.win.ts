/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ITestHandle } from '../test';
import Dap from '../../dap/api';
import { itIntegrates } from '../testIntegrationUtils';
import { IChromeLaunchConfiguration } from '../../configuration';
import { DebugType } from '../../common/contributionUtils';

describe('webview breakpoints', () => {
  async function waitForPause(p: ITestHandle, cb?: (threadId: string) => Promise<void>) {
    const { threadId } = p.log(await p.dap.once('stopped'));
    await p.logger.logStackTrace(threadId);
    if (cb) await cb(threadId);
    return p.dap.continue({ threadId });
  }

  itIntegrates('launched script', async ({ r }) => {
    // Breakpoint in separate script set after launch.
    const p = await r.launchUrl('script.html', ({
      type: DebugType.Edge,
      runtimeExecutable: r.workspacePath('webview/win/WebView2Sample.exe'),
      useWebView: true,
      // WebView2Sample.exe launches about:blank
      urlFilter: 'about:blank',
      // TODO: Test.launchUrl should support AnyLaunchConfiguration
    } as unknown) as IChromeLaunchConfiguration);
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
