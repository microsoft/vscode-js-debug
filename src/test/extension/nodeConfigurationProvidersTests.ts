import * as vscode from 'vscode';
import { expect } from 'chai';
import { NodeDebugConfigurationProvider } from '../../nodeDebugConfigurationProvider';
import { createFileTree, testFixturesDir } from '../test';
import { itIntegrates } from '../testIntegrationUtils';

describe('NodeDebugConfigurationProvider', () => {
  const provider = new NodeDebugConfigurationProvider();
  const folder: vscode.WorkspaceFolder = {
    uri: vscode.Uri.file(testFixturesDir),
    name: 'test-dir',
    index: 0,
  };

  itIntegrates('loads the program from a package.json if available', async () => {
    createFileTree(testFixturesDir, {
      'hello.js': '',
      'package.json': JSON.stringify({ main: 'hello.js' }),
    });

    const result = await provider.resolveDebugConfiguration(folder, {
      type: '',
      name: '',
      request: '',
    });

    expect(result).to.containSubset({
      type: 'pwa-node',
      cwd: testFixturesDir,
      name: 'Launch Program',
      program: '${workspaceFolder}/hello.js',
      request: 'launch',
    });
  });
});
