/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { ChildProcess, spawn } from 'child_process';
import { promises as fsPromises } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { createSandbox, SinonSandbox } from 'sinon';
import * as vscode from 'vscode';
import { Commands, DebugType } from '../../common/contributionUtils';
import { findOpenPort } from '../../common/findOpenPort';
import { LocalFsUtils } from '../../common/fsUtils';
import { delay } from '../../common/promiseUtil';
import { StreamSplitter } from '../../common/streamSplitter';
import { nodeAttachConfigDefaults } from '../../configuration';
import { resolveProcessId } from '../../ui/processPicker';
import { createFileTree } from '../createFileTree';
import { removePrivatePrefix } from '../test';
import { eventuallyOk } from '../testIntegrationUtils';

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

    after(async () => {
      await fsPromises.rm(testDir, { recursive: true, force: true });
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
      await resolveProcessId(new LocalFsUtils(fsPromises), config, true);
      expect(removePrivatePrefix(config.cwd!)).to.equal(testDir);
    });

    it('adjusts to the package root', async () => {
      createFileTree(testDir, {
        'package.json': '{}',
        'nested/foo.js': 'setInterval(() => {}, 1000)',
      });

      child = spawn('node', ['foo.js'], { cwd: path.join(testDir, 'nested') });
      const config = { ...nodeAttachConfigDefaults, processId: `${child.pid}:1234` };
      await resolveProcessId(new LocalFsUtils(fsPromises), config, true);
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
      await resolveProcessId(new LocalFsUtils(fsPromises), config, true);
      expect(removePrivatePrefix(config.cwd!)).to.equal(path.join(testDir, 'nested'));
    });
  }

  describe('', () => {
    beforeEach(async () => {
      port = await findOpenPort();
      child = spawn('node', ['--inspect-brk', `--inspect-port=${port}`], { stdio: 'pipe' });
      child.on('error', console.error);
      child
        .stderr!.pipe(new StreamSplitter('\n'))
        .on(
          'data',
          (
            line: string,
          ) => (attached = attached || line.toString().includes('Debugger attached')),
        );
    });

    it('end to end', async function() {
      this.timeout(30 * 1000);

      const createQuickPick = sandbox.spy(vscode.window, 'createQuickPick');
      vscode.commands.executeCommand(Commands.AttachProcess);

      await delay(2000);
      const picker = await eventuallyOk(() => {
        expect(createQuickPick.called).to.be.true;
        return createQuickPick.getCall(0).returnValue;
      }, 10 * 1000);

      await delay(2000);
      const item = await eventuallyOk(() => {
        const i = picker.items.find(item => (item as any).pidAndPort === `${child.pid}:${port}`);
        if (!i) {
          throw new Error('expected quickpick to have item');
        }
        return i;
      }, 10 * 1000);

      picker.selectedItems = [item];
      await delay(2000);
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      await delay(2000);
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
