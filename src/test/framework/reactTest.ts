/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as cp from 'child_process';
import { join } from 'path';
import { getDeferred } from '../../common/promiseUtil';
import Dap from '../../dap/api';
import { killTree } from '../../targets/node/killTree';
import { ITestHandle, testFixturesDir } from '../test';
import { itIntegrates } from '../testIntegrationUtils';
import * as mkdirp from 'mkdirp';
import { Logger } from '../../common/logging/logger';

describe('react', () => {
  async function waitForPause(p: ITestHandle, cb?: (threadId: string) => Promise<void>) {
    const { threadId } = p.log(await p.dap.once('stopped'));
    await p.logger.logStackTrace(threadId);
    if (cb) await cb(threadId);
    return p.dap.continue({ threadId });
  }

  const projectName = 'react-test';
  let projectFolder: string;
  let devServerProc: cp.ChildProcessWithoutNullStreams | undefined;

  afterEach(() => {
    if (devServerProc) {
      console.log('Killing ' + devServerProc.pid);
      killTree(devServerProc.pid, Logger.null);
    }
  });

  describe('TS', () => {
    beforeEach(async function () {
      this.timeout(60000 * 4);
      projectFolder = join(testFixturesDir, projectName);
      await setupCRA(projectName, testFixturesDir, ['--template', 'cra-template-typescript']);
      devServerProc = await startDevServer(projectFolder);
    });

    itIntegrates('hit breakpoint', async ({ r }) => {
      // Breakpoint in inline script set before launch.
      const p = await r._launch('http://localhost:3000', {
        webRoot: projectFolder,
        __workspaceFolder: projectFolder,
        rootPath: projectFolder,
      });
      const source: Dap.Source = {
        path: join(projectFolder, 'src/App.tsx'),
      };
      await p.dap.setBreakpoints({ source, breakpoints: [{ line: 6, column: 0 }] });
      p.load();
      await waitForPause(p);
      p.assertLog({ substring: true });
    });
  });

  describe('JS', () => {
    beforeEach(async function () {
      this.timeout(60000 * 4);
      projectFolder = join(testFixturesDir, projectName);
      await setupCRA(projectName, testFixturesDir);
      devServerProc = await startDevServer(projectFolder);
    });

    itIntegrates('hit breakpoint', async ({ r }) => {
      // Breakpoint in inline script set before launch.
      const p = await r._launch('http://localhost:3000', {
        webRoot: projectFolder,
        __workspaceFolder: projectFolder,
        rootPath: projectFolder,
      });
      const source: Dap.Source = {
        path: join(projectFolder, 'src/App.js'),
      };
      await p.dap.setBreakpoints({ source, breakpoints: [{ line: 6, column: 0 }] });
      p.load();
      await waitForPause(p);
      p.assertLog({ substring: true });
    });
  });
});

async function setupCRA(projectName: string, cwd: string, args: string[] = []): Promise<void> {
  console.log('Setting up CRA in ' + cwd);
  mkdirp.sync(cwd);
  const setupProc = cp.spawn('npx', ['create-react-app', ...args, projectName], {
    cwd,
    stdio: 'pipe',
    env: process.env,
  });
  setupProc.stdout.on('data', d => console.log(d.toString().replace(/\r?\n$/, '')));
  setupProc.stderr.on('data', d => console.error(d.toString().replace(/\r?\n$/, '')));

  const done = getDeferred();
  setupProc.once('exit', () => {
    done.resolve(undefined);
  });
  await done.promise;
}

async function startDevServer(projectFolder: string): Promise<cp.ChildProcessWithoutNullStreams> {
  const devServerListening = getDeferred();
  const devServerProc = cp.spawn('npm', ['run-script', 'start'], {
    env: { ...process.env, BROWSER: 'none', SKIP_PREFLIGHT_CHECK: 'true' },
    cwd: projectFolder,
    stdio: 'pipe',
  });
  const timer = setTimeout(() => {
    console.log('Did not get recognized dev server output, continuing');
    devServerListening.resolve(undefined);
  }, 10000);
  devServerProc.stdout.on('data', d => {
    d = d.toString();
    if (d.includes('You can now view')) {
      console.log('Detected CRA dev server started');
      devServerListening.resolve(undefined);
    } else if (d.includes('Something is already')) {
      devServerListening.reject(new Error('Failed to start the dev server: ' + d));
    }

    console.log(d.toString().replace(/\r?\n$/, ''));
  });
  devServerProc.stderr.on('data', d => console.error(d.toString().replace(/\r?\n$/, '')));
  await devServerListening.promise;
  clearTimeout(timer);

  return devServerProc;
}
