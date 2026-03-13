/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import * as vscode from 'vscode';
import { DebugType } from '../../common/contributionUtils';
import { upcastPartial } from '../../common/objUtils';
import {
  editorBrowserAttachConfigDefaults,
  editorBrowserLaunchConfigDefaults,
} from '../../configuration';
import { EditorBrowserDebugConfigurationResolver } from '../../ui/configuration/editorBrowserDebugConfigurationProvider';
import { testFixturesDir } from '../test';
import { TestMemento } from '../testMemento';

describe('EditorBrowserDebugConfigurationProvider', () => {
  let provider: EditorBrowserDebugConfigurationResolver;
  const folder: vscode.WorkspaceFolder = {
    uri: vscode.Uri.file(testFixturesDir),
    name: 'test-dir',
    index: 0,
  };

  beforeEach(() => {
    provider = new EditorBrowserDebugConfigurationResolver(
      upcastPartial<vscode.ExtensionContext>({
        logPath: testFixturesDir,
        workspaceState: new TestMemento(),
      }),
    );
  });

  describe('launch config', () => {
    it('returns null for empty config', async () => {
      const result = await provider.resolveDebugConfiguration(folder, {
        type: '',
        name: '',
        request: '',
      });
      expect(result).to.be.null;
    });

    it('applies launch defaults', async () => {
      const result = await provider.resolveDebugConfiguration(folder, {
        type: DebugType.EditorBrowser,
        name: 'test',
        request: 'launch',
        url: 'http://localhost:3000',
      });

      expect(result).to.containSubset({
        type: DebugType.EditorBrowser,
        request: 'launch',
        url: 'http://localhost:3000',
        webRoot: editorBrowserLaunchConfigDefaults.webRoot,
        disableNetworkCache: editorBrowserLaunchConfigDefaults.disableNetworkCache,
      });
    });

    it('user config overrides defaults', async () => {
      const result = await provider.resolveDebugConfiguration(folder, {
        type: DebugType.EditorBrowser,
        name: 'test',
        request: 'launch',
        url: 'http://localhost:9000',
        webRoot: '/custom/path',
      });

      expect(result).to.containSubset({
        url: 'http://localhost:9000',
        webRoot: '/custom/path',
      });
    });
  });

  describe('attach config', () => {
    it('applies attach defaults', async () => {
      const result = await provider.resolveDebugConfiguration(folder, {
        type: DebugType.EditorBrowser,
        name: 'test',
        request: 'attach',
      });

      expect(result).to.containSubset({
        type: DebugType.EditorBrowser,
        request: 'attach',
        webRoot: editorBrowserAttachConfigDefaults.webRoot,
        disableNetworkCache: editorBrowserAttachConfigDefaults.disableNetworkCache,
      });
    });

    it('user config overrides attach defaults', async () => {
      const result = await provider.resolveDebugConfiguration(folder, {
        type: DebugType.EditorBrowser,
        name: 'test',
        request: 'attach',
        webRoot: '/my/root',
      });

      expect(result).to.containSubset({
        type: DebugType.EditorBrowser,
        request: 'attach',
        webRoot: '/my/root',
      });
    });
  });
});
