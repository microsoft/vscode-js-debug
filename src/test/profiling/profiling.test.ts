/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { testWorkspace, testFixturesDir, ITestHandle } from '../test';
import { itIntegrates, eventuallyOk } from '../testIntegrationUtils';
import { expect } from 'chai';
import { join } from 'path';
import del = require('del');
import { promises as fs } from 'fs';
import { delay } from '../../common/promiseUtil';
import { stub, SinonSpy } from 'sinon';
import * as vscode from 'vscode';
import { DebugType, Contributions } from '../../common/contributionUtils';
import { EventEmitter } from '../../common/events';

describe('profiling', () => {
  const cwd = join(testWorkspace, 'simpleNode');
  const script = join(cwd, 'profilePlayground.js');
  const file = join(testFixturesDir, 'result.profile');
  let createQuickPick: SinonSpy;
  let acceptQuickPick: EventEmitter<void>;

  const assertValidOutputFile = async () => {
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

  afterEach(async () => {
    await del([file], { force: true }), createQuickPick.restore();
  });

  itIntegrates('cpu sanity test', async ({ r }) => {
    await r.initialize;

    const handle = await r.runScript(script);
    handle.load();
    await handle.dap.startProfile({ file, type: 'cpu' });
    await delay(300);
    await handle.dap.stopProfile({});
    await assertValidOutputFile();
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
      await handle.dap.startProfile({ file, type: 'cpu' });
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
      await handle.dap.startProfile({ file, type: 'cpu', stopAtBreakpoint: [-1] });
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

      await handle.dap.startProfile({ file, type: 'cpu' });
      await eventuallyOk(() => expect(logfn.callCount).to.gte(1));
      await handle.dap.stopProfile({});
      await eventuallyOk(() => expect(logfn.callCount).to.gte(2));
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
        file,
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

      // Wait for the pause, and call noop after a second which will hit the BP
      const stopped = await handle.dap.once('stopped');
      await handle.dap.evaluate({
        expression: 'setTimeout(noop, 1000)',
        context: 'repl',
        frameId: await getFrameId(stopped.threadId!, handle),
      });

      // Start a profile
      await handle.dap.startProfile({
        file,
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
      await assertValidOutputFile();
      handle.assertLog();
    });
  });

  describe('ui', () => {
    const pickTermination = async (session: vscode.DebugSession, labelRe: RegExp) => {
      vscode.commands.executeCommand(Contributions.StartProfileCommand, session.id);

      const typePicker = await eventuallyOk(() => {
        expect(createQuickPick.callCount).to.equal(1);
        const picker: vscode.QuickPick<vscode.QuickPickItem> = createQuickPick.getCall(0)
          .returnValue;
        expect(picker.items).to.not.be.empty;
        return picker;
      }, 2000);

      typePicker.selectedItems = typePicker.items.filter(i => /CPU/i.test(i.label));
      acceptQuickPick.fire();

      const terminationPicker = await eventuallyOk(() => {
        expect(createQuickPick.callCount).to.equal(2);
        const picker: vscode.QuickPick<vscode.QuickPickItem> = createQuickPick.getCall(1)
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

      await pickTermination(session, /breakpoint/i);

      const breakpointPicker = await eventuallyOk(() => {
        expect(createQuickPick.callCount).to.equal(3);
        const picker: vscode.QuickPick<vscode.QuickPickItem> = createQuickPick.getCall(2)
          .returnValue;
        expect(picker.items).to.not.be.empty;
        return picker;
      }, 2000);

      expect(breakpointPicker.items).to.containSubset([
        {
          label: 'profilePlayground.js:6:16',
        },
        {
          label: 'profilePlayground.js:20:1',
        },
      ]);

      session.customRequest('disconnect', {});
      await new Promise(resolve => vscode.debug.onDidTerminateDebugSession(resolve));
    });
  });
});
