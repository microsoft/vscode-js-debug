/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { itIntegrates } from '../testIntegrationUtils';
import { createFileTree, testFixturesDir, ITestHandle, NodeTestHandle } from '../test';
import { join } from 'path';

describe('node runtime', () => {
  async function waitForPause(p: ITestHandle) {
    const { threadId } = p.log(await p.dap.once('stopped'));
    await p.logger.logStackTrace(threadId);
    return p.dap.continue({ threadId });
  }

  async function evaluate(handle: NodeTestHandle, expression: string) {
    handle.load();
    const { threadId } = handle.log(await handle.dap.once('stopped'));
    const stack = await handle.dap.stackTrace({ threadId });
    await handle.logger.evaluateAndLog(expression, {
      params: {
        frameId: stack.stackFrames[0].id,
      },
    });

    handle.assertLog();
  }

  itIntegrates('simple script', async ({ r }) => {
    createFileTree(testFixturesDir, { 'test.js': ['console.log("hello world");', 'debugger;'] });
    const handle = await r.runScript('test.js');
    handle.load();
    await waitForPause(handle);
    handle.assertLog({ substring: true });
  });

  itIntegrates('debugs child processes', async ({ r }) => {
    createFileTree(testFixturesDir, {
      'test.js': `
        const cp = require('child_process');
        const path = require('path');
        cp.fork(path.join(__dirname, 'child.js'));
      `,
      'child.js': `
        const foo = 'It works!';
        debugger;
      `,
    });

    const handle = await r.runScript('test.js');
    handle.load();

    const worker = await r.worker();
    worker.load();

    const { threadId } = worker.log(await worker.dap.once('stopped'));
    const stack = await worker.dap.stackTrace({ threadId });
    await worker.logger.evaluateAndLog('foo', {
      params: {
        frameId: stack.stackFrames[0].id,
      },
    });

    worker.assertLog();
  });

  itIntegrates('sets environment variables', async ({ r }) => {
    createFileTree(testFixturesDir, { 'test.js': 'debugger' });
    const handle = await r.runScript('test.js', {
      env: {
        HELLO: 'world',
      },
    });

    await evaluate(handle, 'process.env.HELLO');
  });

  itIntegrates('sets environment variables', async ({ r }) => {
    createFileTree(testFixturesDir, { 'test.js': 'debugger' });
    const handle = await r.runScript('test.js', {
      env: {
        HELLO: 'world',
      },
    });

    await evaluate(handle, 'process.env.HELLO');
  });

  itIntegrates('reads the envfile', async ({ r }) => {
    createFileTree(testFixturesDir, {
      'test.js': 'debugger;',
      vars: ['A=foo', 'B=bar'],
    });

    const previousC = process.env.C;
    process.env.C = 'inherited';

    const handle = await r.runScript('test.js', {
      envFile: join(testFixturesDir, 'vars'),
      env: {
        B: 'overwritten',
      },
    });

    await evaluate(
      handle,
      'JSON.stringify({ a: process.env.A, b: process.env.B, c: process.env.C })',
    );

    process.env.C = previousC;
  });
});
