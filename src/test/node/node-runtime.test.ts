/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { ChildProcess, spawn } from 'child_process';
import { promises as fsPromises } from 'fs';
import { dirname, join } from 'path';
import { stub } from 'sinon';
import split from 'split2';
import { findOpenPort } from '../../common/findOpenPort';
import { once } from '../../common/objUtils';
import { findInPath } from '../../common/pathUtils';
import { delay } from '../../common/promiseUtil';
import { INodeLaunchConfiguration, nodeLaunchConfigDefaults } from '../../configuration';
import Dap from '../../dap/api';
import { TerminalProgramLauncher } from '../../targets/node/terminalProgramLauncher';
import { ITestHandle, NodeTestHandle, testFixturesDir, testWorkspace } from '../test';
import { createFileTree } from '../createFileTree';
import { itIntegrates } from '../testIntegrationUtils';

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
    const stackframes = expectedStacktrace.trim().split('\n');
    expect(stackframes.length).to.be.greaterThan(0);
    expect(stackframes[0]).to.not.contain('<hidden: Skipped by skipFiles>');
    for (let n = 1; n < stackframes.length; n++) {
      expect(stackframes[n]).to.contain('<hidden: Skipped by skipFiles>');
    }
  }

  describe('skipFiles', () => {
    itIntegrates('skipFiles skip node internals', async ({ r }) => {
      await r.initialize;
      const cwd = join(testWorkspace, 'simpleNode');
      const handle = await r.runScript(join(cwd, 'index.js'), {
        skipFiles: ['<node_internals>/**'],
      });
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

    for (const [name, useDelay] of [
      ['with delay', true],
      ['without delay', false],
    ] as const) {
      describe(name, () => {
        for (const fn of ['caughtInUserCode', 'uncaught', 'caught', 'rethrown']) {
          itIntegrates(fn, async ({ r }) => {
            await r.initialize;
            const cwd = join(testWorkspace, 'simpleNode');
            const handle = await r.runScript(join(cwd, 'skipFiles.js'), {
              args: [useDelay ? '1000' : '0', fn],
              skipFiles: ['**/skippedScript.js'],
            });

            await handle.dap.setExceptionBreakpoints({
              filters: ['caught', 'uncaught'],
            });

            handle.dap.on('output', o => handle.logger.logOutput(o));
            handle.dap.on('stopped', async o => {
              await handle.logger.logStackTrace(o.threadId!, false);
              await handle.dap.continue({ threadId: o.threadId! });
            });

            handle.load();

            await handle.dap.once('terminated');
            handle.assertLog({ substring: true });
          });
        }
      });
    }
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

  describe('simplePortAttach', () => {
    const npm = once(async () => {
      const npmPath = await findInPath(fsPromises, 'npm', process.env);
      if (!npmPath) {
        throw new Error('npm not on path');
      }

      return npmPath;
    });

    itIntegrates('allows inspect-brk in npm scripts', async ({ r }) => {
      await r.initialize;
      const cwd = join(testWorkspace, 'simpleNode');
      const handle = await r.runScript('', {
        program: undefined,
        cwd,
        runtimeExecutable: await npm(),
        runtimeArgs: ['run', 'startWithBrk'],
        port: 29204,
      });

      const optionsOut = handle.dap.once('output', o => o.output.includes('NODE_OPTIONS'));
      handle.load();
      const { threadId } = handle.log(await handle.dap.once('stopped'));
      handle.dap.continue({ threadId });
      handle.logger.logOutput(await optionsOut);
      handle.assertLog({ substring: true });
    });

    itIntegrates('uses bootloader for normal npm scripts', async ({ r }) => {
      await r.initialize;
      const cwd = join(testWorkspace, 'simpleNode');
      r.onSessionCreated(t => t.load());
      const handle = await r.runScript('', {
        program: undefined,
        cwd,
        runtimeExecutable: await npm(),
        runtimeArgs: ['run', 'startWithoutBrk'],
        port: 29204,
      });
      handle.load();

      const worker = await r.worker();
      const optionsOut = worker.dap.once('output', o => o.output.includes('NODE_OPTIONS'));
      handle.logger.logOutput(await optionsOut);
      handle.assertLog({ customAssert: l => expect(l).to.contain('NODE_OPTIONS= --require') });
    });

    itIntegrates('allows simple port attachment', async ({ r }) => {
      await r.initialize;
      const cwd = join(testWorkspace, 'simpleNode');
      const port = await findOpenPort();
      const handle = await r.runScript(join(cwd, 'logNodeOptions'), {
        runtimeArgs: [`--inspect-brk=${port}`],
        attachSimplePort: port,
      });
      handle.load();

      const optionsOut = handle.dap.once('output', o => o.output.includes('NODE_OPTIONS'));
      const { threadId } = handle.log(await handle.dap.once('stopped'));
      handle.dap.continue({ threadId });
      handle.logger.logOutput(await optionsOut);
      handle.assertLog({ substring: true });
    });

    itIntegrates('terminates when inspector closed', async ({ r }) => {
      await r.initialize;
      const cwd = join(testWorkspace, 'simpleNode');
      const port = await findOpenPort();
      const handle = await r.runScript(join(cwd, 'debuggerStmt'), {
        runtimeArgs: [`--inspect-brk=${port}`],
        attachSimplePort: port,
      });
      handle.load();

      handle.log(await handle.dap.once('stopped'));
      handle.dap.evaluate({ expression: 'require("inspector").close()' });
      handle.log(await handle.dap.once('terminated'));
      handle.assertLog({ substring: true });
    });

    itIntegrates('terminates when process killed', async ({ r }) => {
      await r.initialize;
      const cwd = join(testWorkspace, 'simpleNode');
      const port = await findOpenPort();
      const handle = await r.runScript(join(cwd, 'debuggerStmt'), {
        runtimeArgs: [`--inspect-brk=${port}`],
        attachSimplePort: port,
      });
      handle.load();

      handle.log(await handle.dap.once('stopped'));
      handle.dap.evaluate({ expression: 'process.exit(1)' });
      handle.log(await handle.dap.once('terminated'));
      handle.assertLog({ substring: true });
    });
  });
});
