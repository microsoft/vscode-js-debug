/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { stub, SinonStub } from 'sinon';
import { join } from 'path';
import { expect } from 'chai';
import { NodeConfigurationResolver } from '../../ui/configuration/nodeDebugConfigurationResolver';
import { createFileTree, testFixturesDir } from '../test';
import { DebugType } from '../../common/contributionUtils';
import { EnvironmentVars } from '../../common/environmentVars';
import { INodeLaunchConfiguration } from '../../configuration';

describe('NodeDebugConfigurationProvider', () => {
  let provider: NodeConfigurationResolver;
  let nvmResolver: { resolveNvmVersionPath: SinonStub };
  const folder: vscode.WorkspaceFolder = {
    uri: vscode.Uri.file(testFixturesDir),
    name: 'test-dir',
    index: 0,
  };

  beforeEach(() => {
    nvmResolver = { resolveNvmVersionPath: stub() };
    provider = new NodeConfigurationResolver({ logPath: testFixturesDir } as any, nvmResolver);
    EnvironmentVars.platform = 'linux';
  });

  afterEach(() => {
    EnvironmentVars.platform = process.platform;
  });

  describe('logging resolution', () => {
    const emptyRequest = {
      type: 'node',
      name: '',
      request: '',
    };

    beforeEach(() => {
      createFileTree(testFixturesDir, {
        'hello.js': '',
        'package.json': JSON.stringify({ main: 'hello.js' }),
      });
    });

    it('does not log by default', async () => {
      const result = await provider.resolveDebugConfiguration(folder, emptyRequest);
      expect(result!.trace).to.deep.equal({
        console: false,
        level: 'fatal',
        stdio: false,
        logFile: null,
        tags: [],
      });
    });

    it('applies defaults with trace=true', async () => {
      const result = await provider.resolveDebugConfiguration(folder, {
        ...emptyRequest,
        trace: true,
      });
      expect(result!.trace).to.containSubset({
        console: false,
        level: 'verbose',
        stdio: true,
        logFile: join(testFixturesDir, 'vscode-debugadapter-0.json'),
        tags: [],
      });
    });

    it('applies overrides', async () => {
      const result = await provider.resolveDebugConfiguration(folder, {
        ...emptyRequest,
        trace: {
          level: 'warn',
          tags: ['cdp'],
        },
      });
      expect(result!.trace).to.deep.equal({
        console: false,
        level: 'warn',
        stdio: true,
        logFile: join(testFixturesDir, 'vscode-debugadapter-0.json'),
        tags: ['cdp'],
      });
    });
  });

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

      const result = (await provider.resolveDebugConfiguration(folder, emptyRequest))!;
      result.cwd = result.cwd!.toLowerCase();

      expect(result).to.containSubset({
        type: 'pwa-node',
        cwd: testFixturesDir.toLowerCase(),
        name: 'Launch Program',
        program: join('${workspaceFolder}', 'hello.js'),
        request: 'launch',
      });
    });

    it('loads the program from a package.json start script if available', async () => {
      createFileTree(testFixturesDir, {
        'hello.js': '',
        'package.json': JSON.stringify({ scripts: { start: 'node hello.js' } }),
      });

      const result = (await provider.resolveDebugConfiguration(folder, emptyRequest))!;
      result.cwd = result.cwd!.toLowerCase();

      expect(result).to.containSubset({
        type: 'pwa-node',
        cwd: testFixturesDir.toLowerCase(),
        name: 'Launch Program',
        program: join('${workspaceFolder}', 'hello.js'),
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
          program: join('${workspaceFolder}', 'hello.js'),
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
          program: join('${workspaceFolder}', 'out', 'hello.js'),
          preLaunchTask: 'tsc: build - tsconfig.json',
          outFiles: ['${workspaceFolder}/out/**/*.js'],
        });
      } finally {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      }
    });
  });

  it('attempts to resolve nvm', async () => {
    createFileTree(testFixturesDir, {
      'my.env': 'A=bar\nB="quoted"\n"C"="more quoted"\n\nD=overridden\n',
      'hello.js': '',
    });

    nvmResolver.resolveNvmVersionPath.resolves({
      directory: '/my/node/location',
      binary: 'node64',
    });
    const result = await provider.resolveDebugConfiguration(folder, {
      type: DebugType.Node,
      name: '',
      request: 'launch',
      program: 'hello.js',
      runtimeVersion: '3.1.4',
      env: { hello: 'world', PATH: '/usr/bin' },
    });

    expect(result).to.containSubset({
      runtimeExecutable: 'node64',
      env: {
        hello: 'world',
        PATH: '/usr/bin:/my/node/location',
      },
    });
  });

  describe('inspect flags', () => {
    it('demaps', async () => {
      const result = (await provider.resolveDebugConfiguration(folder, {
        type: DebugType.Node,
        name: '',
        request: 'launch',
        program: 'hello.js',
        runtimeArgs: ['-a', '--inspect-brk', '--b'],
      })) as INodeLaunchConfiguration;

      expect(result.runtimeArgs).to.deep.equal(['-a', '--b']);
      expect(result.stopOnEntry).to.be.true;
    });

    it('does not overwrite existing stop on entry', async () => {
      const result = (await provider.resolveDebugConfiguration(folder, {
        type: DebugType.Node,
        name: '',
        request: 'launch',
        program: 'hello.js',
        stopOnEntry: 'hello.js',
        runtimeArgs: ['-a', '--inspect-brk', '--b'],
      })) as INodeLaunchConfiguration;

      expect(result.runtimeArgs).to.deep.equal(['-a', '--b']);
      expect(result.stopOnEntry).to.equal('hello.js');
    });
  });

  describe('outFiles', () => {
    it('does not modify outfiles with no package.json', async () => {
      createFileTree(testFixturesDir, {
        'hello.js': '',
      });

      const result = await provider.resolveDebugConfiguration(folder, {
        type: DebugType.Node,
        name: '',
        request: 'launch',
        program: 'hello.js',
      });

      expect(result?.outFiles).to.deep.equal(['${workspaceFolder}/**/*.js', '!**/node_modules/**']);
    });

    it('preserves outFiles if package.json is in the same folder', async () => {
      createFileTree(testFixturesDir, {
        'hello.js': '',
        'package.json': '{}',
      });

      const result = await provider.resolveDebugConfiguration(folder, {
        type: DebugType.Node,
        name: '',
        request: 'launch',
        program: 'hello.js',
      });

      expect(result?.outFiles).to.deep.equal(['${workspaceFolder}/**/*.js', '!**/node_modules/**']);
    });

    it('gets the nearest nested package.json', async () => {
      createFileTree(testFixturesDir, {
        'a/b/c/hello.js': '',
        'a/b/package.json': '{}',
        'a/package.json': '{}',
      });

      const result = await provider.resolveDebugConfiguration(folder, {
        type: DebugType.Node,
        name: '',
        request: 'launch',
        program: 'a/b/c/hello.js',
      });

      expect(result?.outFiles).to.deep.equal([
        '${workspaceFolder}/a/b/**/*.js',
        '!**/node_modules/**',
      ]);
    });

    it('does not resolve outside the workspace folder', async () => {
      createFileTree(testFixturesDir, {
        'a/b/c/hello.js': '',
        'package.json': '{}',
      });

      const result = await provider.resolveDebugConfiguration(
        {
          uri: vscode.Uri.file(join(testFixturesDir, 'a')),
          name: 'test-dir',
          index: 0,
        },
        {
          type: DebugType.Node,
          name: '',
          request: 'launch',
          program: 'b/c/hello.js',
        },
      );

      expect(result?.outFiles).to.deep.equal(['${workspaceFolder}/**/*.js', '!**/node_modules/**']);
    });
  });
});
