// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { itIntegrates } from '../testIntegrationUtils';
import { testFixturesDir } from '../test';
import { expect } from 'chai';
import mkdirp from 'mkdirp';
import { readdirSync } from 'fs';

describe('browser launch', () => {
  itIntegrates('environment variables', async ({ r }) => {
    if (process.platform === 'win32') {
      return; // Chrome on windows doesn't set the TZ correctly
    }

    const p = await r.launchUrlAndLoad('index.html', {
      env: {
        TZ: 'GMT',
      },
    });

    await p.logger.evaluateAndLog(`new Date().getTimezoneOffset()`);
    r.assertLog();
  });

  itIntegrates('runtime args', async ({ r }) => {
    const p = await r.launchUrlAndLoad('index.html', {
      runtimeArgs: ['--window-size=678,456'],
    });

    await p.logger.evaluateAndLog(`[window.outerWidth, window.outerHeight]`);
    r.assertLog();
  });

  itIntegrates.skip('user data dir', async ({ r }) => {
    mkdirp.sync(testFixturesDir);
    expect(readdirSync(testFixturesDir)).to.be.empty;

    await r.launchUrlAndLoad('index.html', {
      userDataDir: testFixturesDir,
    });

    expect(readdirSync(testFixturesDir)).to.not.be.empty;
  });
});
