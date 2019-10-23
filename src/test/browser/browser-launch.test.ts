/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { itIntegrates } from '../testIntegrationUtils';
import { testFixturesDir } from '../test';
import { expect } from 'chai';
import mkdirp from 'mkdirp';
import { readdirSync } from 'fs';

describe('browser launch', () => {
  itIntegrates('environment variables', async ({ r }) => {
    const p = await r.launchUrlAndLoad('index.html', {
      env: {
        TZ: 'America/New_York'
      }
    });

    await p.logger.evaluateAndLog(`new Date().getTimezoneOffset()`);
    r.assertLog();
  });

  itIntegrates('runtime args', async ({ r }) => {
    const p = await r.launchUrlAndLoad('index.html', {
      runtimeArgs: ['--window-size=678,456']
    });

    await p.logger.evaluateAndLog(`[window.outerWidth, window.outerHeight]`);
    r.assertLog();
  });

  itIntegrates('user data dir', async ({ r }) => {
    mkdirp.sync(testFixturesDir);
    expect(readdirSync(testFixturesDir)).to.be.empty;

    await r.launchUrlAndLoad('index.html', {
      userDataDir: testFixturesDir
    });

    expect(readdirSync(testFixturesDir)).to.not.be.empty;
  });
});
