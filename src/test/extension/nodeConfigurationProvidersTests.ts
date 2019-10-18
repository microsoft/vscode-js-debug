/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { join } from 'path';
import { expect } from 'chai';
import { NodeDebugConfigurationProvider } from '../../nodeDebugConfigurationProvider';
import { createFileTree, testFixturesDir } from '../test';

describe('NodeDebugConfigurationProvider', () => {
  const provider = new NodeDebugConfigurationProvider();
  const folder: vscode.WorkspaceFolder = {
    uri: vscode.Uri.file(testFixturesDir),
    name: 'test-dir',
    index: 0,
  };

  describe('launch config from context', () => {
    const emptyRequest = {
      type: '',
      name: '',
      request: '',
    };

    it('loads the program from a package.json main if available', async () => {
      createFileTree(testFixturesDir, {
        'hello.js': '',
        'package.json': JSON.stringify({ main: 'hello.js' }),
      });

      const result = await provider.resolveDebugConfiguration(folder, emptyRequest);

      expect(result).to.containSubset({
        type: 'pwa-node',
        cwd: testFixturesDir,
        name: 'Launch Program',
        program: '${workspaceFolder}/hello.js',
        request: 'launch',
      });
    });

    it('loads the program from a package.json start script if available', async () => {
      createFileTree(testFixturesDir, {
        'hello.js': '',
        'package.json': JSON.stringify({ scripts: { start: 'node hello.js' } }),
      });

      const result = await provider.resolveDebugConfiguration(folder, emptyRequest);

      expect(result).to.containSubset({
        type: 'pwa-node',
        cwd: testFixturesDir,
        name: 'Launch Program',
        program: '${workspaceFolder}/hello.js',
        request: 'launch',
      });
    });

    it('configures mern starters', async () => {
      createFileTree(testFixturesDir, {
        'hello.js': '',
        'package.json': JSON.stringify({ name: 'mern-starter' }),
      });

      const result = await provider.resolveDebugConfiguration(folder, emptyRequest);

      expect(result).to.containSubset({
        runtimeExecutable: 'nodemon',
        program: '${workspaceFolder}/index.js',
        restart: true,
        env: { BABEL_DISABLE_CACHE: '1', NODE_ENV: 'development' },
      });
    });

    it('attempts to load the active text editor', async () => {
      createFileTree(testFixturesDir, { 'hello.js': '' });
      const doc = await vscode.workspace.openTextDocument(join(testFixturesDir, 'hello.js'));
      await vscode.window.showTextDocument(doc);

      try {
        const result = await provider.resolveDebugConfiguration(folder, emptyRequest);
        expect(result).to.containSubset({
          program: '${workspaceFolder}/hello.js',
        });
      } finally {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      }
    });

    it('applies tsconfig settings automatically', async () => {
      createFileTree(testFixturesDir, {
        out: { 'hello.js': '' },
        src: { 'hello.ts': '' },
        'package.json': JSON.stringify({ main: 'out/hello.js' }),
        'tsconfig.json': JSON.stringify({ compilerOptions: { outDir: 'out' } }),
      });

      const doc = await vscode.workspace.openTextDocument(join(testFixturesDir, 'src', 'hello.ts'));
      await vscode.window.showTextDocument(doc);
      try {
        const result = await provider.resolveDebugConfiguration(folder, emptyRequest);
        expect(result).to.containSubset({
          program: '${workspaceFolder}/out/hello.js',
          preLaunchTask: 'tsc: build - tsconfig.json',
          outFiles: ['${workspaceFolder}/out/**/*.js'],
        });
      } finally {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      }
    });
  });
});
