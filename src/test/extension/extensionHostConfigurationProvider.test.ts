/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { join } from 'path';
import * as vscode from 'vscode';
import { DebugType } from '../../common/contributionUtils';
import { EnvironmentVars } from '../../common/environmentVars';
import { ExtensionHostConfigurationResolver } from '../../ui/configuration/extensionHostConfigurationResolver';
import { testFixturesDir } from '../test';
import { createFileTree } from '../createFileTree';

describe('ExtensionHostConfigurationProvider', () => {
  let provider: ExtensionHostConfigurationResolver;
  const folder = (name: string): vscode.WorkspaceFolder => ({
    uri: vscode.Uri.file(join(testFixturesDir, name)),
    name: 'test-dir',
    index: 0,
  });

  const emptyRequest = {
    type: DebugType.ExtensionHost,
    name: '',
    request: '',
    args: ['--extensionDevelopmentPath=${workspaceFolder}'],
  };

  beforeEach(() => {
    provider = new ExtensionHostConfigurationResolver({ logPath: testFixturesDir } as any);
    EnvironmentVars.platform = 'linux';
  });

  describe('web worker debugging', () => {
    beforeEach(() =>
      createFileTree(testFixturesDir, {
        'withWeb/package.json': JSON.stringify({ extensionKind: ['web'] }),
        'withoutWeb/package.json': JSON.stringify({}),
      }),
    );

    it('does not enable if no args', async () => {
      const result = await provider.resolveDebugConfiguration(folder('withWeb'), {
        ...emptyRequest,
        args: [],
      });
      expect(result?.debugWebWorkerHost).to.be.false;
    });

    it('does not enable if wrong type', async () => {
      const result = await provider.resolveDebugConfiguration(folder('withoutWeb'), emptyRequest);
      expect(result?.debugWebWorkerHost).to.be.false;
    });

    it('does not enable if enoent folder', async () => {
      const result = await provider.resolveDebugConfiguration(folder('doesNotExist'), emptyRequest);
      expect(result?.debugWebWorkerHost).to.be.false;
    });

    it('does not override existing option', async () => {
      const result = await provider.resolveDebugConfiguration(folder('doesNotExist'), {
        ...emptyRequest,
        debugWebWorkerHost: true,
      });
      expect(result?.debugWebWorkerHost).to.be.true;
    });

    it('enables if all good', async () => {
      const result = await provider.resolveDebugConfiguration(folder('withWeb'), emptyRequest);
      expect(result?.debugWebWorkerHost).to.be.true;
    });
  });
});
