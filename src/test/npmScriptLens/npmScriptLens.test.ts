/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { join } from 'path';
import { expect } from 'chai';
import { createFileTree, testFixturesDir } from '../test';
import { NpmScriptLenProvider } from '../../ui/npmScriptLens';
import { Configuration, writeConfig } from '../../common/contributionUtils';

function prepareFileTree() {
  createFileTree(testFixturesDir, {
    'package.json': JSON.stringify(
      {
        name: 'demo',
        version: '1.0.0',
        scripts: {
          foo: 'bar',
          bar: 'foo',
        },
        sub: {
          scripts: {
            hello: 'world',
          },
        },
      },
      null,
      2,
    ),
  });
}

const setLocation = (location: 'all' | 'top') =>
  writeConfig(vscode.workspace, Configuration.NpmScriptLens, location);

describe('npmScriptLens', () => {
  describe('with location=top', () => {
    it('uses the scripts property at root level only', async () => {
      try {
        prepareFileTree();
        await setLocation('top');
        const doc = await vscode.workspace.openTextDocument(join(testFixturesDir, 'package.json'));
        const provider = new NpmScriptLenProvider();

        const result = await provider.provideCodeLenses(doc);
        expect(result).to.not.be.null;
        expect(result).to.have.length(1);
        const expectedPos = new vscode.Position(3, 3);
        const top = result![0];
        const range = top.range;
        expect(range.start).to.deep.equal(expectedPos);
        expect(range.end).to.deep.equal(expectedPos);
        expect(top.isResolved).to.be.true;
        expect(top.command?.arguments).to.not.be.undefined;
        expect(top.command?.arguments).to.have.length(1);
      } finally {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      }
    });
  });
  describe('with location=all', () => {
    it('uses the scripts property at root level only', async () => {
      try {
        prepareFileTree();
        await setLocation('all');

        const doc = await vscode.workspace.openTextDocument(join(testFixturesDir, 'package.json'));
        const provider = new NpmScriptLenProvider();

        const result = await provider.provideCodeLenses(doc);
        expect(result).to.not.be.null;
        expect(result).to.have.length(2);
        const expectedPosFoo = new vscode.Position(4, 5);
        const foo = result![0];
        expect(foo.range.start).to.deep.equal(expectedPosFoo);
        expect(foo.range.end).to.deep.equal(expectedPosFoo);
        expect(foo.isResolved).to.be.true;
        expect(foo.command?.arguments).to.deep.equal([
          'npm run foo',
          vscode.workspace.workspaceFolders?.[0],
          { cwd: testFixturesDir },
        ]);

        const bar = result![1];
        const expectedPosBar = new vscode.Position(5, 5);
        expect(bar.range.start).to.deep.equal(expectedPosBar);
        expect(bar.range.end).to.deep.equal(expectedPosBar);
        expect(bar.isResolved).to.be.true;
        expect(bar.command?.arguments).to.deep.equal([
          'npm run bar',
          vscode.workspace.workspaceFolders?.[0],
          { cwd: testFixturesDir },
        ]);
      } finally {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      }
    });
  });
});
