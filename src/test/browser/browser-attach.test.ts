/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import * as net from 'net';
import * as path from 'path';
import { chromium } from 'playwright-core';
import { AnyChromiumConfiguration, chromeAttachConfigDefaults } from '../../configuration';
import { ITestHandle, TestP, testWorkspace } from '../test';
import { itIntegrates } from '../testIntegrationUtils';

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('Failed to allocate a free TCP port')));
        return;
      }
      const { port } = addr;
      server.close(err => (err ? reject(err) : resolve(port)));
    });
  });
}

describe('browser attach', () => {
  itIntegrates('attaches to existing JS child targets on already-open pages', async ({ r }) => {
    const port = await getFreePort();
    const exe = require('playwright-core/lib/server').registry.findExecutable(
      'chromium-headless-shell',
    );
    const browser = await chromium.launch({
      executablePath: exe.executablePathOrDie(),
      args: [`--remote-debugging-port=${port}`, '--site-per-process'],
    });

    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(r.buildUrl('frames.html'));
      await page.waitForFunction(() => Boolean((window as unknown as { w?: Worker }).w));

      await r.initialize;

      const attachedHandles: ITestHandle[] = [];
      const childTargetsReady = new Promise<void>(resolve => {
        const disposable = r.onSessionCreated(handle => {
          attachedHandles.push(handle);
          if (handle instanceof TestP) {
            void handle.dap.configurationDone({});
            void handle.dap.attach({});
          }
          const types = new Set(r.binder.targetList().map(t => t.type()));
          if (types.has('page') && types.has('iframe') && types.has('worker')) {
            disposable.dispose();
            resolve();
          }
        });
      });

      r.rootDap().launch({
        ...chromeAttachConfigDefaults,
        port,
        urlFilter: r.buildUrl('frames.html'),
        webRoot: path.join(testWorkspace, 'web'),
        rootPath: testWorkspace,
        __workspaceFolder: testWorkspace,
      } as AnyChromiumConfiguration);

      await childTargetsReady;

      const targetTypes = r.binder.targetList().map(t => t.type());
      expect(targetTypes).to.include('page');
      expect(targetTypes).to.include('iframe');
      expect(targetTypes).to.include('worker');

      const childHandle = attachedHandles.find(h => !(h instanceof TestP));
      expect(childHandle).to.exist;

      const evalResult = await childHandle!.dap.evaluate({
        expression: '1 + 1',
        context: 'repl',
      });
      expect(evalResult.result).to.equal('2');
    } finally {
      await browser.close();
    }
  });
});
