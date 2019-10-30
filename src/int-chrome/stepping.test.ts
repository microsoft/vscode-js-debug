// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as path from 'path';
import { createServer } from 'http-server';

import * as testSetup from './testSetup';
import { HttpOrHttpsServer } from './types/server';
import { ExtendedDebugClient } from './testSupport/debugClient';

suite('Stepping', () => {
  const DATA_ROOT = testSetup.DATA_ROOT;

  let dc: ExtendedDebugClient;
  setup(function() {
    return testSetup.setup(this).then(_dc => (dc = _dc));
  });

  let server: HttpOrHttpsServer | null;
  teardown(async () => {
    if (server) {
      server.close(err => console.log('Error closing server in teardown: ' + (err && err.message)));
      server = null;
    }

    await testSetup.teardown();
  });

  suite.skip('skipFiles', () => {
    test('when generated script is skipped via regex, the source can be un-skipped', async () => {
      const testProjectRoot = path.join(DATA_ROOT, 'calls-between-merged-files');
      const sourceA = path.join(testProjectRoot, 'sourceA.ts');
      const sourceB2 = path.join(testProjectRoot, 'sourceB2.ts');

      server = createServer({ root: testProjectRoot });
      server.listen(7890);

      const url = 'http://localhost:7890/index.html';

      // Skip the full B generated script via launch config
      const bpLineA = 6;
      const skipFiles = ['b.js'];
      await dc.hitBreakpointUnverified(
        { url, skipFiles, webRoot: testProjectRoot },
        { path: sourceA, line: bpLineA },
      );

      // Step in, verify B sources are skipped
      await dc.stepInRequest();
      await dc.assertStoppedLocation('step', { path: sourceA, line: 2 });
      await dc.send('toggleSkipFileStatus', { path: sourceB2 });

      // Continue back to sourceA, step in, should skip B1 and land on B2
      await dc.continueRequest();
      await dc.assertStoppedLocation('breakpoint', { path: sourceA, line: bpLineA });
      await dc.stepInRequest();
      await dc.assertStoppedLocation('step', { path: sourceB2, line: 2 });
    });

    test('when a non-sourcemapped script is skipped via regex, it can be unskipped', async () => {
      // Using this program, but run with sourcemaps disabled
      const testProjectRoot = path.join(DATA_ROOT, 'calls-between-sourcemapped-files');
      const sourceA = path.join(testProjectRoot, 'out/sourceA.js');
      const sourceB = path.join(testProjectRoot, 'out/sourceB.js');

      server = createServer({ root: testProjectRoot });
      server.listen(7890);

      const url = 'http://localhost:7890/index.html';

      // Skip the full B generated script via launch config
      const skipFiles = ['sourceB.js'];
      const bpLineA = 5;
      await dc.hitBreakpointUnverified(
        { url, sourceMaps: false, skipFiles, webRoot: testProjectRoot },
        { path: sourceA, line: bpLineA },
      );

      // Step in, verify B sources are skipped
      await dc.stepInRequest();
      await dc.assertStoppedLocation('step', { path: sourceA, line: 2 });
      await dc.send('toggleSkipFileStatus', { path: sourceB });

      // Continue back to A, step in, should land in B
      await dc.continueRequest();
      await dc.assertStoppedLocation('breakpoint', { path: sourceA, line: bpLineA });
      await dc.stepInRequest();
      await dc.assertStoppedLocation('step', { path: sourceB, line: 2 });
    });

    test('skip statuses for sourcemapped files are persisted across page reload', async () => {
      const testProjectRoot = path.join(DATA_ROOT, 'calls-between-merged-files');
      const sourceA = path.join(testProjectRoot, 'sourceA.ts');
      const sourceB2 = path.join(testProjectRoot, 'sourceB2.ts');

      server = createServer({ root: testProjectRoot });
      server.listen(7890);

      const url = 'http://localhost:7890/index.html';

      // Skip the full B generated script via launch config
      const bpLineA = 6;
      const skipFiles = ['b.js'];
      await dc.hitBreakpointUnverified(
        { url, skipFiles, webRoot: testProjectRoot },
        { path: sourceA, line: bpLineA },
      );
      await Promise.all([dc.stepInRequest(), dc.waitForEvent('stopped')]);

      // Un-skip b2 and refresh the page
      await Promise.all([
        // Wait for extra pause event sent after toggling skip status
        dc.waitForEvent('stopped'),
        dc.send('toggleSkipFileStatus', { path: sourceB2 }),
      ]);

      await Promise.all([
        dc.send('restart'),
        dc.assertStoppedLocation('breakpoint', { path: sourceA, line: bpLineA }),
      ]);

      // Persisted bp should be hit. Step in, and assert we stepped through B1 into B2
      await Promise.all([
        dc.stepInRequest(),
        dc.assertStoppedLocation('step', { path: sourceB2, line: 2 }),
      ]);
    });
  });
});
