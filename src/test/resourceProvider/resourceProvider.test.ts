/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { itIntegrates } from '../testIntegrationUtils';
import { ITestHandle } from '../test';

describe('resourceProvider', () => {
  async function waitForPause(p: ITestHandle, cb?: (threadId: string) => Promise<void>) {
    const { threadId } = p.log(await p.dap.once('stopped'));
    await p.logger.logStackTrace(threadId);
    if (cb) await cb(threadId);
    return p.dap.continue({ threadId });
  }

  itIntegrates('applies cookies', async ({ r }) => {
    // Breakpoint in source mapped script set before launch.
    // Note: this only works in Chrome 76 or later and Node 12 or later, since it relies
    // on 'pause before executing script with source map' functionality in CDP.
    const p = await r.launchUrl('cookies/home');
    p.load();
    await waitForPause(p);
    p.assertLog();
  });
});
