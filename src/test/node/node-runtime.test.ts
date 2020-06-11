/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { itIntegrates } from '../testIntegrationUtils';
import {
  createFileTree,
  testFixturesDir,
  ITestHandle,
  NodeTestHandle,
  testWorkspace,
} from '../test';
import { join, dirname } from 'path';
import { expect } from 'chai';
import { stub } from 'sinon';
import { TerminalProgramLauncher } from '../../targets/node/terminalProgramLauncher';
import { spawn, ChildProcess } from 'child_process';
import Dap from '../../dap/api';
import { delay } from '../../common/promiseUtil';
import { nodeLaunchConfigDefaults, INodeLaunchConfiguration } from '../../configuration';
import split from 'split2';

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

  function assertSkipFiles(expectedStacktrace: string) {
    const stackframes = expectedStacktrace.split('\n').splice(-1, 1); // removing last empty element
    expect(stackframes.length).to.be.greaterThan(0);
    expect(stackframes[0]).to.not.contain('<hidden: Skipped by skipFiles>');
    for (let n = 1; n < stackframes.length; n++) {
      expect(stackframes[n]).to.contain('<hidden: Skipped by skipFiles>');
    }
  }

  itIntegrates('skipFiles skip node internals', async ({ r }) => {
    await r.initialize;
    const cwd = join(testWorkspace, 'simpleNode');
    const handle = await r.runScript(join(cwd, 'index.js'), { skipFiles: ['<node_internals>/**'] });
    await handle.dap.setBreakpoints({
      source: { path: join(cwd, 'index.js') },
      breakpoints: [{ line: 1, column: 1 }],
    });

    handle.load();
    const stoppedParams = await handle.dap.once('stopped');
    await delay(200); // need to pause test to let debouncer update scripts
    await handle.logger.logStackTrace(stoppedParams.threadId!, false);
    handle.assertLog({ customAssert: assertSkipFiles });
  });

  itIntegrates('simple script', async ({ r }) => {
    createFileTree(testFixturesDir, { 'test.js': ['console.log("hello world");', 'debugger;'] });
    const handle = await r.runScript('test.js');
    handle.load();
    await waitForPause(handle);
    handle.assertLog({ substring: true });
  });

  itIntegrates('exits with child process launcher', async ({ r }) => {
    createFileTree(testFixturesDir, { 'test.js': '' });
    const handle = await r.runScript('test.js', { console: 'internalConsole' });
    handle.load();
    await handle.dap.once('terminated');
  });

  itIntegrates('exits with integrated terminal launcher', async ({ r }) => {
    // We don't actually attach the DAP fully through vscode, so stub about
    // the launch request. We just want to test that the lifecycle of a detached
    // process is handled correctly.
    const launch = stub(TerminalProgramLauncher.prototype, 'sendLaunchRequest');
    after(() => launch.restore());

    let receivedRequest: Dap.RunInTerminalParams | undefined;
    launch.callsFake((request: Dap.RunInTerminalParams) => {
      receivedRequest = request;
      spawn(request.args[0], request.args.slice(1), {
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
      });

      return Promise.resolve({});
    });

    createFileTree(testFixturesDir, { 'test.js': '' });
    const handle = await r.runScript('test.js', {
      console: 'integratedTerminal',
      cwd: testFixturesDir,
      env: { myEnv: 'foo' },
    });
    handle.load();
    await handle.dap.once('terminated');
    expect(receivedRequest).to.containSubset({
      title: 'Node Debug Console',
      kind: 'integrated',
      cwd: testFixturesDir,
      env: { myEnv: 'foo' },
    });
  });

  itIntegrates('adjusts to compiles file if it exists', async ({ r }) => {
    await r.initialize;

    const handle = await r.runScript(join(testWorkspace, 'web/basic.ts'));
    await handle.dap.setBreakpoints({
      source: { path: handle.workspacePath('web/basic.ts') },
      breakpoints: [{ line: 21, column: 0 }],
    });
    handle.load();

    await waitForPause(handle);
    handle.assertLog({ substring: true });
  });

  describe('inspect flag handling', () => {
    itIntegrates('does not break with inspect flag', async ({ r }) => {
      createFileTree(testFixturesDir, { 'test.js': ['console.log("hello world");', 'debugger;'] });
      const handle = await r.runScript('test.js', {
        runtimeArgs: ['--inspect'],
      });
      handle.load();
      await waitForPause(handle);
      handle.assertLog({ substring: true });
    });

    itIntegrates('treats inspect-brk as stopOnEntry', async ({ r }) => {
      createFileTree(testFixturesDir, { 'test.js': ['console.log("hello world");'] });
      const handle = await r.runScript('test.js', {
        cwd: testFixturesDir,
        runtimeArgs: ['--inspect-brk'],
      });
      handle.load();
      await waitForPause(handle);
      handle.assertLog({ substring: true });
    });
  });

  describe('stopOnEntry', () => {
    beforeEach(() =>
      createFileTree(testFixturesDir, {
        'test.js': ['let i = 0;', 'i++;', 'i++;'],
        'bar.js': 'require("./test")',
      }),
    );

    itIntegrates('stops with a breakpoint elsewhere (#515)', async ({ r }) => {
      const handle = await r.runScript('test.js', {
        cwd: testFixturesDir,
        stopOnEntry: true,
      });

      await handle.dap.setBreakpoints({
        source: { path: join(testFixturesDir, 'test.js') },
        breakpoints: [{ line: 3, column: 1 }],
      });

      handle.load();
      await waitForPause(handle);
      r.assertLog({ substring: true });
    });

    itIntegrates('stops with a program provided', async ({ r }) => {
      const handle = await r.runScript('test.js', {
        cwd: testFixturesDir,
        stopOnEntry: true,
      });

      handle.load();
      await waitForPause(handle);
      r.assertLog({ substring: true });
    });

    itIntegrates('launches and infers entry from args', async ({ r }) => {
      const handle = await r.runScript('test.js', {
        cwd: testFixturesDir,
        args: ['--max-old-space-size=1024', 'test.js', '--not-a-file'],
        program: undefined,
        stopOnEntry: true,
      });

      handle.load();
      await waitForPause(handle);
      r.assertLog({ substring: true });
    });

    itIntegrates('sets an explicit stop on entry point', async ({ r }) => {
      const handle = await r.runScript('bar.js', {
        cwd: testFixturesDir,
        stopOnEntry: join(testFixturesDir, 'test.js'),
      });

      handle.load();
      await waitForPause(handle);
      r.assertLog({ substring: true });
    });
  });

  describe('attaching', () => {
    let child: ChildProcess | undefined;

    afterEach(() => {
      if (child) {
        child.kill();
      }
    });

    itIntegrates('attaches to existing processes', async ({ r }) => {
      createFileTree(testFixturesDir, {
        'test.js': ['setInterval(() => { debugger; }, 500)'],
      });

      child = spawn('node', ['--inspect', join(testFixturesDir, 'test')]);
      await delay(500); // give it a moment to boot
      const handle = await r.attachNode(child.pid);
      await waitForPause(handle);
      handle.assertLog({ substring: true });
    });

    // todo(connor4312): I'm having a really hard time getting this to pass. I
    // think there might be funky with out test setup, works fine running manually.
    itIntegrates.skip('continueOnAttach', async ({ r }) => {
      createFileTree(testFixturesDir, {
        'test.js': ['console.log("");', 'debugger;'],
      });

      child = spawn('node', ['--inspect-brk', join(testFixturesDir, 'test')]);
      const handle = await r.attachNode(0, { continueOnAttach: true });
      await waitForPause(handle); // pauses on 2nd line, not 1st
      handle.assertLog({ substring: true });
    });

    itIntegrates('retries attachment', async ({ r }) => {
      createFileTree(testFixturesDir, {
        'test.js': ['setInterval(() => { debugger; }, 500)'],
      });

      const handleProm = r.attachNode(0, { port: 9229 });
      await delay(500); // give it a moment to start trying to attach
      child = spawn('node', ['--inspect', join(testFixturesDir, 'test')]);
      const handle = await handleProm;
      await waitForPause(handle);
      handle.assertLog({ substring: true });
    });

    itIntegrates('attaches children of child processes', async ({ r }) => {
      createFileTree(testFixturesDir, {
        'test.js': `
          const { spawn } = require('child_process');
          setInterval(() => spawn('node', ['child'], { cwd: __dirname }), 500);
        `,
        'child.js': '(function foo() { debugger; })();',
      });

      child = spawn('node', ['--inspect', join(testFixturesDir, 'test')]);
      await delay(500); // give it a moment to boot
      const handle = await r.attachNode(child.pid);
      handle.load();

      const worker = await r.worker();
      worker.load();

      await waitForPause(worker);
      worker.assertLog({ substring: true });
    });

    itIntegrates('attaches to cluster processes', async ({ r }) => {
      createFileTree(testFixturesDir, {
        'test.js': `
          const cluster = require('cluster');
          if (cluster.isMaster) {
            cluster.fork();
          } else {
            setInterval(() => { debugger; }, 500);
          }
        `,
      });

      child = spawn('node', ['--inspect', join(testFixturesDir, 'test')]);
      await delay(500); // give it a moment to boot
      const handle = await r.attachNode(child.pid);
      handle.load();

      const worker = await r.worker();
      worker.load();

      await waitForPause(worker);
      worker.assertLog({ substring: true });
    });

    itIntegrates('restarts if requested', async ({ r }) => {
      createFileTree(testFixturesDir, {
        'test.js': ['setInterval(() => { debugger; }, 100)'],
      });

      child = spawn('node', ['--inspect', join(testFixturesDir, 'test')]);
      const handle = await r.attachNode(0, { port: 9229, restart: true });

      handle.log(await handle.dap.once('stopped'));
      await handle.dap.evaluate({ expression: 'process.exit(0)' });

      child = spawn('node', ['--inspect', join(testFixturesDir, 'test')]);
      const reconnect = await r.waitForTopLevel();
      reconnect.load();

      await waitForPause(reconnect);
      handle.assertLog({ substring: true });
    });

    itIntegrates('does not restart if killed', async ({ r }) => {
      createFileTree(testFixturesDir, {
        'test.js': ['setInterval(() => { debugger; }, 100)'],
      });

      child = spawn('node', ['--inspect', join(testFixturesDir, 'test')], { stdio: 'pipe' });
      const lines: string[] = [];
      child.stderr?.pipe(split()).on('data', line => lines.push(line));

      const handle = await r.attachNode(0, { port: 9229, restart: true });
      await handle.dap.once('stopped');
      await r.rootDap().disconnect({});

      await delay(1000);
      expect(lines.filter(l => l.includes('Debugger attached'))).to.have.lengthOf(1);
    });
  });

  describe('child processes', () => {
    beforeEach(() =>
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
      }),
    );

    itIntegrates('debugs', async ({ r }) => {
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

    itIntegrates('does not debug if auto attach off', async ({ r }) => {
      const handle = await r.runScript('test.js', { autoAttachChildProcesses: false });
      handle.load();

      const result = await Promise.race([
        r.worker(),
        new Promise(r => setTimeout(() => r('ok'), 1000)),
      ]);

      expect(result).to.equal('ok');
    });
  });

  itIntegrates('sets arguments', async ({ r }) => {
    createFileTree(testFixturesDir, { 'test.js': 'debugger' });
    const handle = await r.runScript('test.js', {
      args: ['--some', 'very fancy', '--arguments'],
    });

    await evaluate(handle, 'process.argv.slice(2)');
  });

  itIntegrates('sets the cwd', async ({ r }) => {
    createFileTree(testFixturesDir, { 'test.js': 'debugger' });
    const handle = await r.runScript('test.js', {
      cwd: testWorkspace,
    });

    await evaluate(handle, 'process.cwd()');
  });

  itIntegrates('sets sourceMapOverrides from the cwd', async ({ r }) => {
    const handle = await r.runScript(join(testWorkspace, 'simpleNode', 'simpleWebpack.js'), {
      cwd: join(testWorkspace, 'simpleNode'),
    });

    handle.load();
    await waitForPause(handle);
    handle.assertLog({ substring: true });
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

  itIntegrates('writes errors if runtime executable not found', async ({ r }) => {
    await r.initialize;
    const result = await r.rootDap().launch({
      ...nodeLaunchConfigDefaults,
      cwd: dirname(testFixturesDir),
      program: join(testFixturesDir, 'test.js'),
      rootPath: testWorkspace,
      runtimeExecutable: 'does-not-exist',
      __workspaceFolder: testFixturesDir,
    } as INodeLaunchConfiguration);

    expect(result).to.include('Can\'t find Node.js binary "does-not-exist"');
  });

  itIntegrates('scripts with http urls', async ({ r }) => {
    await r.initialize;
    const cwd = join(testWorkspace, 'web', 'urlSourcemap');
    const handle = await r.runScript(join(cwd, 'index.js'), {
      cwd: testWorkspace,
      skipFiles: ['<node_internals>/**'],
      sourceMapPathOverrides: { 'http://localhost:8001/*': `${testWorkspace}/web/*` },
    });
    handle.load();
    await waitForPause(handle);
    handle.assertLog({ substring: true });
  });
});
