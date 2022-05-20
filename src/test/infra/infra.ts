/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { itIntegrates } from '../testIntegrationUtils';

describe('infra', () => {
  itIntegrates('initialize', async ({ r }) => {
    r.log(await r.initialize);
    r.assertLog();
  });

  it('imports win32 app container tokens', async () => {
    if (process.platform === 'win32') {
      await import('@vscode/win32-app-container-tokens'); // should not fail
    }
  });
});
