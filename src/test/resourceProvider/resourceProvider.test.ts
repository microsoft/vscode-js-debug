/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { promises as fs } from 'fs';
import { BasicResourceProvider } from '../../adapter/resourceProvider/basicResourceProvider';
import { ITestHandle } from '../test';
import { itIntegrates } from '../testIntegrationUtils';

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

  itIntegrates('follows redirects', async ({ r }) => {
    const p = await r.launchUrl('redirect-test/home');
    p.load();
    p.log(await p.waitForSource('module1.ts'));
    p.assertLog();
  });

  it('decodes base64 data uris', async () => {
    const rp = new BasicResourceProvider(fs);
    expect(await rp.fetch('data:text/plain;base64,SGVsbG8gd29ybGQh')).to.deep.equal({
      ok: true,
      statusCode: 200,
      body: 'Hello world!',
    });
  });

  it('decodes utf8 data uris (#662)', async () => {
    const rp = new BasicResourceProvider(fs);
    expect(await rp.fetch('data:text/plain;utf-8,Hello%20world!')).to.deep.equal({
      ok: true,
      statusCode: 200,
      body: 'Hello world!',
    });
  });

  it('fetches remote url', async () => {
    const rp = new BasicResourceProvider(fs);
    expect(await rp.fetch('http://localhost:8001/greet')).to.deep.equal({
      ok: true,
      statusCode: 200,
      body: 'Hello world!',
    });
  });

  it('follows redirects (unit)', async () => {
    const rp = new BasicResourceProvider(fs);
    expect(await rp.fetch('http://localhost:8001/redirect-to-greet')).to.deep.equal({
      ok: true,
      statusCode: 200,
      body: 'Hello world!',
    });
  });
});
