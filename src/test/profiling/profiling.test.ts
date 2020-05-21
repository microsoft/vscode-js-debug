/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { testWorkspace, ITestHandle } from '../test';
import { itIntegrates, eventuallyOk } from '../testIntegrationUtils';
import { expect } from 'chai';
import { join } from 'path';
import { promises as fs } from 'fs';
import { delay } from '../../common/promiseUtil';
import { stub, SinonSpy } from 'sinon';
import * as vscode from 'vscode';
import { DebugType, runCommand, Commands } from '../../common/contributionUtils';
import { EventEmitter } from '../../common/events';
import { DisposableList } from '../../common/disposable';

describe('profiling', () => {
  const cwd = join(testWorkspace, 'simpleNode');
  const script = join(cwd, 'profilePlayground.js');
  let createQuickPick: SinonSpy;
  let acceptQuickPick: EventEmitter<void>;

  const assertValidOutputFile = async (file: string) => {
    const contents = await fs.readFile(file, 'utf-8');
    expect(() => JSON.parse(contents)).to.not.throw(
      undefined,
      'expected to be valid JSON: ' + contents,
    );
  };

  const getFrameId = async (threadId: number, handle: ITestHandle) =>
    (await handle.dap.stackTrace({ threadId })).stackFrames[0].id;

  beforeEach(() => {
    const original = vscode.window.createQuickPick;
    createQuickPick = stub(vscode.window, 'createQuickPick').callsFake(() => {
      const picker = original();
      acceptQuickPick = new EventEmitter<void>();
      stub(picker, 'onDidAccept').callsFake(acceptQuickPick.event);
      return picker;
    });
  });

  afterEach(() => {
    createQuickPick.restore();
  });

  itIntegrates('cpu sanity test', async ({ r }) => {
    await r.initialize;

    const handle = await r.runScript(script);
    handle.load();
    const startedEvent = handle.dap.once('profileStarted');
    await handle.dap.startProfile({ type: 'cpu' });
    await delay(300);
    await handle.dap.stopProfile({});
    await assertValidOutputFile((await startedEvent).file);
  });

  describe('breakpoints', () => {
    itIntegrates('continues if was paused on start', async ({ r }) => {
      await r.initialize;

      const handle = await r.runScript(script);
      await handle.load();
      handle.log(
        await handle.dap.setBreakpoints({
          source: { path: script },
          breakpoints: [{ line: 21, column: 1 }],
        }),
      );

      handle.log(await handle.dap.once('stopped'));
      const continued = handle.dap.once('continued');
      const output = handle.dap.once('output');
      await handle.dap.startProfile({ type: 'cpu' });
      handle.log(await continued);
      handle.log(await output); // make sure it *actually* continued
      handle.assertLog();
    });

    itIntegrates('continues if was paused on start with debugger domain', async ({ r }) => {
      await r.initialize;

      const handle = await r.runScript(script);
      await handle.load();
      handle.log(
        await handle.dap.setBreakpoints({
          source: { path: script },
          breakpoints: [{ line: 21, column: 1 }],
        }),
      );

      handle.log(await handle.dap.once('stopped'));
      const continued = handle.dap.once('continued');
      const output = handle.dap.once('output');
      await handle.dap.startProfile({ type: 'cpu', stopAtBreakpoint: [-1] });
      handle.log(await continued);
      handle.log(await output); // make sure it *actually* continued
      handle.assertLog();
    });

    itIntegrates('unverifies and reverifies', async ({ r }) => {
      await r.initialize;

      const handle = await r.runScript(script);
      await handle.load();
      handle.log(
        await handle.dap.setBreakpoints({
          source: { path: script },
          breakpoints: [{ line: 6, column: 1 }],
        }),
        undefined,
        [],
      );

      await delay(0);

      const logfn = stub().callsFake(data => handle.log(data, undefined, []));
      handle.dap.on('breakpoint', logfn);

      await handle.dap.startProfile({ type: 'cpu' });
      await eventuallyOk(() => expect(logfn.callCount).to.gte(1), 2000);
      await handle.dap.stopProfile({});
      await eventuallyOk(() => expect(logfn.callCount).to.gte(2), 2000);
      handle.assertLog();
    });

    itIntegrates('does not unverify target breakpoint', async ({ r }) => {
      await r.initialize;

      const handle = await r.runScript(script);
      await handle.load();
      const { breakpoints } = handle.log(
        await handle.dap.setBreakpoints({
          source: { path: script },
          breakpoints: [
            { line: 6, column: 1 },
            { line: 17, column: 1 },
          ],
        }),
        undefined,
        [],
      );

      await delay(0);

      const logfn = stub().callsFake(data => handle.log(data, undefined, []));
      handle.dap.on('breakpoint', logfn);

      await handle.dap.startProfile({
        type: 'cpu',
        stopAtBreakpoint: [breakpoints[1].id],
      });
      await eventuallyOk(() => expect(logfn.callCount).to.gte(1));
      await handle.dap.stopProfile({});
      await eventuallyOk(() => expect(logfn.callCount).to.gte(2));
      handle.assertLog();
    });

    itIntegrates('runs until a breakpoint is hit', async ({ r }) => {
      await r.initialize;

      const handle = await r.runScript(script);
      const { breakpoints } = await handle.dap.setBreakpoints({
        source: { path: script },
        breakpoints: [
          { line: 20, column: 1 }, // entry bp to let us set the timeout
          { line: 17, column: 1 }, // inside the "noop" function
        ],
      });

      await handle.load();

      const startedEvent = handle.dap.once('profileStarted');

      // Wait for the pause, and call noop after a second which will hit the BP
      const stopped = await handle.dap.once('stopped');
      await handle.dap.evaluate({
        expression: 'setTimeout(noop, 1000)',
        context: 'repl',
        frameId: await getFrameId(stopped.threadId!, handle),
      });

      // Start a profile
      await handle.dap.startProfile({
        type: 'cpu',
        stopAtBreakpoint: [breakpoints[1].id!],
      });

      // We should hit the breakpoint, stop the profile, and re-verify the first breakpoint.
      const paused = handle.dap.once('stopped');
      const profileFinished = handle.dap.once('profilerStateUpdate');
      const breakpointReenabled = handle.dap.once(
        'breakpoint',
        evt => evt.breakpoint.id === breakpoints[0].id && evt.breakpoint.verified,
      );
      handle.log(await paused, 'paused event');
      handle.log(await profileFinished, 'finished profile');
      handle.log(await breakpointReenabled, 'reenabled breakpoint', []);
      await assertValidOutputFile((await startedEvent).file);
      handle.assertLog();
    });
  });

  describe('ui', () => {
    let session: vscode.DebugSession | undefined;

    afterEach(async () => {
      if (session) {
        session.customRequest('disconnect', {});
        session = undefined;
        await new Promise(resolve => vscode.debug.onDidTerminateDebugSession(resolve));
      }
    });

    const pickTermination = async (session: vscode.DebugSession, labelRe: RegExp) => {
      vscode.commands.executeCommand(Commands.StartProfile, session.id);

      // we skip this step while "cpu" is the only profile:
      // const typePicker = await eventuallyOk(() => {
      //   expect(createQuickPick.callCount).to.equal(1);
      //   const picker: vscode.QuickPick<vscode.QuickPickItem> = createQuickPick.getCall(0)
      //     .returnValue;
      //   expect(picker.items).to.not.be.empty;
      //   return picker;
      // }, 2000);

      // typePicker.selectedItems = typePicker.items.filter(i => /CPU/i.test(i.label));
      // acceptQuickPick.fire();

      const terminationPicker = await eventuallyOk(() => {
        // expect(createQuickPick.callCount).to.equal(2);
        expect(createQuickPick.callCount).to.equal(1);
        const picker: vscode.QuickPick<vscode.QuickPickItem> = createQuickPick.getCall(0)
          .returnValue;
        expect(picker.items).to.not.be.empty;
        return picker;
      }, 2000);

      terminationPicker.selectedItems = terminationPicker.items.filter(i => labelRe.test(i.label));
      acceptQuickPick.fire();
    };

    it('allows picking breakpoints', async () => {
      vscode.debug.addBreakpoints([
        new vscode.SourceBreakpoint(
          new vscode.Location(vscode.Uri.file(script), new vscode.Position(19, 0)),
        ),
        new vscode.SourceBreakpoint(
          new vscode.Location(vscode.Uri.file(script), new vscode.Position(5, 0)),
        ),
        new vscode.SourceBreakpoint(
          new vscode.Location(vscode.Uri.file(script + '.foo'), new vscode.Position(0, 0)),
        ),
      ]);

      after(() => {
        vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
      });

      vscode.debug.startDebugging(undefined, {
        type: DebugType.Node,
        request: 'launch',
        name: 'test',
        program: script,
      });

      const session = await new Promise<vscode.DebugSession>(resolve =>
        vscode.debug.onDidStartDebugSession(s =>
          '__pendingTargetId' in s.configuration ? resolve(s) : undefined,
        ),
      );

      await eventuallyOk(async () => {
        const { breakpoints } = await session.customRequest('getBreakpoints');
        expect(breakpoints.length).to.be.greaterThan(0, 'expected to set breakpoints');
      }, 5000);

      await pickTermination(session, /breakpoint/i);

      const breakpointPicker = await eventuallyOk(() => {
        expect(createQuickPick.callCount).to.equal(2);
        const picker: vscode.QuickPick<vscode.QuickPickItem> = createQuickPick.getCall(1)
          .returnValue;
        expect(picker.items.length).to.be.greaterThan(0, 'expected to have picker items');
        return picker;
      }, 5000);

      expect(breakpointPicker.items).to.containSubset([
        {
          description: 'for (let i = 0; i < 10; i++) {',
          label: 'testWorkspace/simpleNode/profilePlayground.js:6:16',
        },
        {
          description: 'setInterval(() => {',
          label: 'testWorkspace/simpleNode/profilePlayground.js:20:1',
        },
      ]);

      breakpointPicker.dispose();
    });

    it('sets substate correctly', async () => {
      const disposable = new DisposableList();
      disposable.push(vscode.commands.registerCommand('js-debug.test.callback', () => undefined));

      vscode.debug.startDebugging(undefined, {
        type: DebugType.Node,
        request: 'launch',
        name: 'test',
        program: script,
      });

      const session = await new Promise<vscode.DebugSession>(resolve =>
        vscode.debug.onDidStartDebugSession(s =>
          '__pendingTargetId' in s.configuration ? resolve(s) : undefined,
        ),
      );

      await runCommand(vscode.commands, Commands.StartProfile, {
        sessionId: session.id,
        type: 'cpu',
        termination: { type: 'manual' },
      });

      await eventuallyOk(() => expect(session.name).to.contain('Profiling'), 2000);
      await runCommand(vscode.commands, Commands.StopProfile, session.id);
      await eventuallyOk(() => expect(session.name).to.not.contain('Profiling'), 2000);
      disposable.dispose();
    });

    it('works with pure command API', async () => {
      const callback = stub();
      const disposable = new DisposableList();
      disposable.push(vscode.commands.registerCommand('js-debug.test.callback', callback));

      vscode.debug.startDebugging(undefined, {
        type: DebugType.Node,
        request: 'launch',
        name: 'test',
        program: script,
      });

      const session = await new Promise<vscode.DebugSession>(resolve =>
        vscode.debug.onDidStartDebugSession(s =>
          '__pendingTargetId' in s.configuration ? resolve(s) : undefined,
        ),
      );

      await runCommand(vscode.commands, Commands.StartProfile, {
        sessionId: session.id,
        type: 'cpu',
        termination: { type: 'manual' },
        onCompleteCommand: 'js-debug.test.callback',
      });

      await delay(1000);

      await runCommand(vscode.commands, Commands.StopProfile, session.id);

      const args = await eventuallyOk(() => {
        expect(callback.called).to.be.true;
        return callback.getCall(0).args[0];
      }, 2000);

      expect(() => JSON.parse(args.contents)).to.not.throw;
      expect(args.basename).to.match(/\.cpuprofile$/);
      disposable.dispose();
    });

    it('profiles from launch', async () => {
      vscode.debug.startDebugging(undefined, {
        type: DebugType.Node,
        request: 'launch',
        name: 'test',
        program: script,
        profileStartup: true,
      });

      const session = await new Promise<vscode.DebugSession>(resolve =>
        vscode.debug.onDidStartDebugSession(s =>
          '__pendingTargetId' in s.configuration ? resolve(s) : undefined,
        ),
      );

      await eventuallyOk(() => expect(session.name).to.contain('Profiling'), 2000);
      await runCommand(vscode.commands, Commands.StopProfile, session.id);
      await eventuallyOk(() => expect(session.name).to.not.contain('Profiling'), 2000);
    });
  });
});
