/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import * as vscode from 'vscode';
import { DebugType } from '../../common/contributionUtils';
import { upcastPartial } from '../../common/objUtils';
import {
  codeBrowserAttachConfigDefaults,
  codeBrowserLaunchConfigDefaults,
} from '../../configuration';
import { CodeBrowserDebugConfigurationResolver } from '../../ui/configuration/codeBrowserDebugConfigurationProvider';
import { testFixturesDir } from '../test';
import { TestMemento } from '../testMemento';

describe('CodeBrowserDebugConfigurationProvider', () => {
  let provider: CodeBrowserDebugConfigurationResolver;
  const folder: vscode.WorkspaceFolder = {
    uri: vscode.Uri.file(testFixturesDir),
    name: 'test-dir',
    index: 0,
  };

  beforeEach(() => {
    provider = new CodeBrowserDebugConfigurationResolver(
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
        type: DebugType.CodeBrowser,
        name: 'test',
        request: 'launch',
        url: 'http://localhost:3000',
      });

      expect(result).to.containSubset({
        type: DebugType.CodeBrowser,
        request: 'launch',
        url: 'http://localhost:3000',
        webRoot: codeBrowserLaunchConfigDefaults.webRoot,
        disableNetworkCache: codeBrowserLaunchConfigDefaults.disableNetworkCache,
      });
    });

    it('user config overrides defaults', async () => {
      const result = await provider.resolveDebugConfiguration(folder, {
        type: DebugType.CodeBrowser,
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
        type: DebugType.CodeBrowser,
        name: 'test',
        request: 'attach',
      });

      expect(result).to.containSubset({
        type: DebugType.CodeBrowser,
        request: 'attach',
        webRoot: codeBrowserAttachConfigDefaults.webRoot,
        disableNetworkCache: codeBrowserAttachConfigDefaults.disableNetworkCache,
      });
    });

    it('user config overrides attach defaults', async () => {
      const result = await provider.resolveDebugConfiguration(folder, {
        type: DebugType.CodeBrowser,
        name: 'test',
        request: 'attach',
        webRoot: '/my/root',
      });

      expect(result).to.containSubset({
        type: DebugType.CodeBrowser,
        request: 'attach',
        webRoot: '/my/root',
      });
    });
  });
});
