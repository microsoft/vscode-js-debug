/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { ChildProcess, spawn } from 'child_process';
import { promises as fsPromises } from 'fs';
import { dirname, join } from 'path';
import { stub } from 'sinon';
import { EnvironmentVars } from '../../common/environmentVars';
import { findOpenPort } from '../../common/findOpenPort';
import { once } from '../../common/objUtils';
import { findInPath } from '../../common/pathUtils';
import { delay } from '../../common/promiseUtil';
import { StreamSplitter } from '../../common/streamSplitter';
import {
  INodeLaunchConfiguration,
  nodeLaunchConfigDefaults,
  OutputSource,
} from '../../configuration';
import Dap from '../../dap/api';
import { TerminalProgramLauncher } from '../../targets/node/terminalProgramLauncher';
import { createFileTree } from '../createFileTree';
import { ITestHandle, NodeTestHandle, testFixturesDir, testWorkspace } from '../test';
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
      await handle.logger.logStackTrace(stoppedParams.threadId!);
      handle.assertLog({ customAssert: assertSkipFiles });
    });

    for (
      const [name, useDelay] of [
        ['with delay', true],
        ['without delay', false],
      ] as const
    ) {
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
              filters: ['all', 'uncaught'],
            });

            handle.dap.on('output', o => handle.logger.logOutput(o));
            handle.dap.on('stopped', async o => {
              await handle.logger.logStackTrace(o.threadId!);
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

  itIntegrates('chakracore string value', async ({ r }) => {
    if (process.platform !== 'win32') {
      return;
    }

    createFileTree(testFixturesDir, {
      'test.js': ['const message = "hello world!";', 'console.log(message);', 'debugger;'],
    });
    const chakracore = join(testWorkspace, 'chakracore', 'ChakraCore.Debugger.Sample.exe');
    const port = await findOpenPort();
    const handle = await r.runScript('test.js', {
      runtimeExecutable: chakracore,
      runtimeArgs: ['--inspect-brk', '--port', `${port}`],
      attachSimplePort: port,
      continueOnAttach: true,
    });

    handle.load();
    const { threadId } = handle.log(await handle.dap.once('stopped'));
    handle.dap.continue({ threadId });
    await handle.dap.once('stopped');

    const stack = await handle.dap.stackTrace({ threadId });
    await handle.logger.evaluateAndLog('message', {
      params: {
        frameId: stack.stackFrames[0].id,
      },
    });

    handle.assertLog({ substring: true });
  });

  itIntegrates('exits with child process launcher', async ({ r }) => {
    createFileTree(testFixturesDir, { 'test.js': '' });
    const handle = await r.runScript('test.js', { console: 'internalConsole' });
    handle.load();
    await handle.dap.once('terminated');
  });

  if (process.env.ONLY_MINSPEC !== 'true') {
    // not available on node 8
    itIntegrates('debugs worker threads', async ({ r }) => {
      // note: __filename is broken up in the below script to
      // avoid the esbuild plugin that replaces them in tests 🙈
      createFileTree(testFixturesDir, {
        'test.js': [
          'const { Worker, isMainThread, workerData } = require("worker_threads");',
          'if (isMainThread) {',
          '  new Worker(__f' + 'ilename, { workerData: { greet: "world" } });',
          '} else {',
          '  setInterval(() => {',
          '    console.log("hello " + workerData.greet);',
          '   }, 100);',
          '}',
        ],
      });

      const handle = await r.runScript('test.js');
      handle.load();

      const worker = await r.worker();
      await worker.dap.setBreakpoints({
        source: { path: join(testFixturesDir, 'test.js') },
        breakpoints: [{ line: 6, column: 1 }],
      });

      worker.load();

      await waitForPause(worker);
      handle.assertLog({ substring: true });
    });
  }

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
      title: 'Test Case',
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
      createFileTree(testFixturesDir, {
        'test.js': ['console.log("hello world");', 'debugger;'],
      });
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
      })
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

      const port = await findOpenPort();
      child = spawn('node', [`--inspect=${port}`, join(testFixturesDir, 'test')]);
      await delay(500); // give it a moment to boot
      const handle = await r.attachNode(child.pid!, { port });
      await waitForPause(handle);
      handle.assertLog({ substring: true });
    });

    // todo(connor4312): I'm having a really hard time getting this to pass. I
    // think there might be funky with out test setup, works fine running manually.
    itIntegrates.skip('continueOnAttach', async ({ r }) => {
      createFileTree(testFixturesDir, {
        'test.js': ['console.log("");', 'debugger;'],
      });

      const port = await findOpenPort();
      child = spawn('node', [`--inspect-brk=${port}`, join(testFixturesDir, 'test')]);
      const handle = await r.attachNode(child.pid!, { continueOnAttach: true, port });
      await waitForPause(handle); // pauses on 2nd line, not 1st
      handle.assertLog({ substring: true });
    });

    itIntegrates('retries attachment', async ({ r }) => {
      createFileTree(testFixturesDir, {
        'test.js': ['setInterval(() => { debugger; }, 500)'],
      });

      const port = await findOpenPort();
      const handleProm = r.attachNode(0, { port });
      await delay(500); // give it a moment to start trying to attach
      child = spawn('node', [`--inspect=${port}`, join(testFixturesDir, 'test')]);
      const handle = await handleProm;
      await waitForPause(handle);
      handle.assertLog({ substring: true });
    });

    itIntegrates('attaches children of child processes', async ({ r }) => {
      createFileTree(testFixturesDir, {
        'test.js': `
          const { spawn } = require('child_process');
          setInterval(() => spawn('node', ['child'], { cwd: __dir${''}name }), 500);
        `,
        'child.js': '(function foo() { debugger; })();',
      });

      const port = await findOpenPort();
      child = spawn('node', [`--inspect=${port}`, join(testFixturesDir, 'test')]);
      await delay(500); // give it a moment to boot
      const handle = await r.attachNode(child.pid!, { port });
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

      const port = await findOpenPort();
      child = spawn('node', [`--inspect=${port}`, join(testFixturesDir, 'test')]);
      await delay(500); // give it a moment to boot
      const handle = await r.attachNode(child.pid!, { port });
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

      const port = await findOpenPort();
      child = spawn('node', [`--inspect=${port}`, join(testFixturesDir, 'test')]);
      const handle = await r.attachNode(0, { port, restart: true });

      handle.log(await handle.dap.once('stopped'));
      await handle.dap.evaluate({ expression: 'process.exit(0)' });

      child = spawn('node', [`--inspect=${port}`, join(testFixturesDir, 'test')]);
      const reconnect = await r.waitForTopLevel();
      reconnect.load();

      await waitForPause(reconnect);
      handle.assertLog({ substring: true });
    });

    itIntegrates('does not restart if killed', async ({ r }) => {
      createFileTree(testFixturesDir, {
        'test.js': ['setInterval(() => { debugger; }, 100)'],
      });

      const port = await findOpenPort();
      child = spawn('node', [`--inspect=${port}`, join(testFixturesDir, 'test')], {
        stdio: 'pipe',
      });
      const lines: string[] = [];
      child.stderr?.pipe(new StreamSplitter('\n')).on(
        'data',
        line => lines.push(line.toString()),
      );

      const handle = await r.attachNode(0, { port, restart: true });
      await handle.dap.once('stopped');
      await handle.dap.disconnect({});
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
        cp.fork(path.join(__dir${''}name, 'child.js'));
      `,
        'child.js': `
        const foo = 'It works!';
        debugger;
      `,
      })
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

    EnvironmentVars.processEnv.forget();
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
    EnvironmentVars.processEnv.forget();
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

  itIntegrates('gets performance information', async ({ r }) => {
    createFileTree(testFixturesDir, { 'test.js': 'setInterval(() => {}, 1000)' });
    const handle = await r.runScript('test.js');
    await handle.load();
    const res = await handle.dap.getPerformance({});
    expect(res.error).to.be.undefined;
    expect(res.metrics).to.not.be.empty;
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
      handle.assertLog({ customAssert: l => expect(l).to.contain('NODE_OPTIONS=  --require') });
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

      const { threadId } = handle.log(await handle.dap.once('stopped'));
      const stack = await handle.dap.stackTrace({ threadId });
      handle.dap.evaluate({
        expression: 'require("inspector").close()',
        frameId: stack.stackFrames[0].id,
      });
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

  describe('etx', () => {
    itIntegrates('stdio without etx', async ({ r }) => {
      await r.initialize;

      createFileTree(testFixturesDir, {
        'test.js': ['process.stdout.write("hello world!");', 'debugger;'],
      });
      const handle = await r.runScript('test.js', { outputCapture: OutputSource.Stdio });
      handle.load();
      let logs = '';
      r.rootDap().on('output', p => (logs += p.output));
      await handle.dap.once('stopped');
      expect(logs).to.deep.equal('hello world!');
    });

    itIntegrates('stdio with etx', async ({ r }) => {
      await r.initialize;

      createFileTree(testFixturesDir, {
        'test.js': [
          'process.stdout.write("etx\u0003start");',
          'process.stdout.write("well defined\u0003");',
          'process.stdout.write("chunks\u0003\u0003now!\u0003");',
        ],
      });
      const handle = await r.runScript('test.js', { outputCapture: OutputSource.Stdio });
      handle.load();
      const logs: string[] = [];
      r.rootDap().on('output', p => logs.push(p.output));
      await handle.dap.once('terminated');

      expect(logs.slice(0, 5)).to.deep.equal([
        'etx\n',
        'startwell defined\n',
        'chunks\n',
        '\n',
        'now!\n',
      ]);
    });
  });
});
