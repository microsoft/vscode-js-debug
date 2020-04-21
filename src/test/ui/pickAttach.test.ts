/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { spawn, ChildProcess } from 'child_process';
import { findOpenPort } from '../../common/findOpenPort';
import * as vscode from 'vscode';
import { DebugType, Commands } from '../../common/contributionUtils';
import { SinonSandbox, createSandbox } from 'sinon';
import { eventuallyOk } from '../testIntegrationUtils';
import { expect } from 'chai';
import split from 'split2';
import { createFileTree, removePrivatePrefix } from '../test';
import { resolveProcessId } from '../../ui/processPicker';
import { nodeAttachConfigDefaults } from '../../configuration';
import * as path from 'path';
import { tmpdir } from 'os';
import del from 'del';
import { forceForwardSlashes } from '../../common/pathUtils';

describe('pick and attach', () => {
  const testDir = path.join(tmpdir(), 'js-debug-pick-and-attach');
  let child: ChildProcess;
  let sandbox: SinonSandbox;
  let port: number;
  let attached = false;

  beforeEach(() => (sandbox = createSandbox()));
  afterEach(async () => {
    sandbox?.restore();
    child?.kill();

    await del([`${forceForwardSlashes(testDir)}/**`], {
      force: true /* delete outside cwd */,
    });
  });

  if (process.platform !== 'win32') {
    // perform these in a separate test dir so that we don't have an extra
    // package.json from the test workspace
    it('infers the working directory', async () => {
      createFileTree(testDir, {
        'foo.js': 'setInterval(() => {}, 1000)',
      });

      child = spawn('node', ['foo.js'], { cwd: testDir });
      const config = { ...nodeAttachConfigDefaults, processId: `${child.pid}:1234` };
      await resolveProcessId(config, true);
      expect(removePrivatePrefix(config.cwd!)).to.equal(testDir);
    });

    it('adjusts to the package root', async () => {
      createFileTree(testDir, {
        'package.json': '{}',
        'nested/foo.js': 'setInterval(() => {}, 1000)',
      });

      child = spawn('node', ['foo.js'], { cwd: path.join(testDir, 'nested') });
      const config = { ...nodeAttachConfigDefaults, processId: `${child.pid}:1234` };
      await resolveProcessId(config, true);
      expect(removePrivatePrefix(config.cwd!)).to.equal(testDir);
    });

    it('limits inference to workspace root', async () => {
      createFileTree(testDir, {
        'package.json': '{}',
        'nested/foo.js': 'setInterval(() => {}, 1000)',
      });

      const getWorkspaceFolder = sandbox.stub(vscode.workspace, 'getWorkspaceFolder');
      getWorkspaceFolder.returns({
        name: 'nested',
        index: 1,
        uri: vscode.Uri.file(path.join(testDir, 'nested')),
      });

      child = spawn('node', ['foo.js'], { cwd: path.join(testDir, 'nested') });
      const config = { ...nodeAttachConfigDefaults, processId: `${child.pid}:1234` };
      await resolveProcessId(config, true);
      expect(removePrivatePrefix(config.cwd!)).to.equal(path.join(testDir, 'nested'));
    });
  }

  describe('', () => {
    beforeEach(async () => {
      port = await findOpenPort();
      child = spawn('node', ['--inspect-brk', `--inspect-port=${port}`], { stdio: 'pipe' });
      child.on('error', console.error);
      child
        .stderr!.pipe(split())
        .on('data', (line: string) => (attached = attached || line.includes('Debugger attached')));
    });

    it('end to end', async function () {
      this.timeout(30 * 1000);

      const createQuickPick = sandbox.spy(vscode.window, 'createQuickPick');
      vscode.commands.executeCommand(Commands.AttachProcess);

      const picker = await eventuallyOk(() => {
        expect(createQuickPick.called).to.be.true;
        return createQuickPick.getCall(0).returnValue;
      });

      const item = await eventuallyOk(() => {
        const i = picker.items.find(item => (item as any).pidAndPort === `${child.pid}:${port}`);
        if (!i) {
          throw new Error('expected quickpick to have item');
        }
        return i;
      }, 10 * 1000);

      picker.selectedItems = [item];
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      await eventuallyOk(
        () => expect(attached).to.equal(true, 'expected to have attached'),
        10 * 1000,
      );
    });

    it('works without a defined workspace', async () => {
      vscode.debug.startDebugging(undefined, {
        type: DebugType.Node,
        request: 'attach',
        name: 'attach',
        processId: `${child.pid}:${port}`,
      });

      await eventuallyOk(
        () => expect(attached).to.equal(true, 'expected to have attached'),
        10 * 1000,
      );
    });
  });
});
