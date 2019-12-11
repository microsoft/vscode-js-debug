// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as path from 'path';
import { createServer } from 'http-server';
import { expect } from 'chai';

import * as testSetup from './testSetup';
import { HttpOrHttpsServer } from './types/server';
import { ExtendedDebugClient } from './testSupport/debugClient';

suite('Breakpoints', () => {
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

  suite('getPossibleBreakpoints', () => {
    const testProjectRoot = path.join(DATA_ROOT, 'columns');
    const scriptPath = path.join(testProjectRoot, 'src/script.ts');

    setup(async () => {
      const url = 'http://localhost:7890/index.html';
      server = createServer({ root: testProjectRoot });
      server.listen(7890);

      await dc.hitBreakpointUnverified(
        { url, webRoot: testProjectRoot },
        { path: scriptPath, line: 4, column: 16 },
      );
    });

    test('gets breakpoints on a single line', async () => {
      const result = await dc.breakpointLocations({
        source: { path: scriptPath },
        line: 4,
      });

      expect(result).to.deep.equal({
        breakpoints: [
          { line: 4, column: 9 },
          { line: 4, column: 16 },
          { line: 4, column: 24 },
        ],
      });
    });

    test('gets breakpoints across multiple lines', async () => {
      const result = await dc.breakpointLocations({
        source: { path: scriptPath },
        line: 3,
        column: 2,
        endLine: 4,
        endColumn: 20,
      });

      expect(result).to.deep.equal({
        breakpoints: [
          { line: 3, column: 18 },
          { line: 3, column: 21 },
          { line: 3, column: 28 },
          { line: 4, column: 9 },
          { line: 4, column: 16 },
        ],
      });
    });

    test('no-ops if getting breakpoints outside range', async () => {
      const result = await dc.breakpointLocations({
        source: { path: scriptPath },
        line: 100,
      });

      expect(result.breakpoints).to.be.empty;
    });

    test('no-ops if getting a non-existent file', async () => {
      const result = await dc.breakpointLocations({
        source: { path: 'potato.js' },
        line: 100,
      });

      expect(result.breakpoints).to.be.empty;
    });
  });

  suite('Column BPs', () => {
    test('Column BP is hit on correct column', async () => {
      const testProjectRoot = path.join(DATA_ROOT, 'columns');
      const scriptPath = path.join(testProjectRoot, 'src/script.ts');

      server = createServer({ root: testProjectRoot });
      server.listen(7890);

      const url = 'http://localhost:7890/index.html';

      const bpLine = 4;

      const bpCol = 16;
      await dc.hitBreakpointUnverified(
        { url, webRoot: testProjectRoot },
        { path: scriptPath, line: bpLine, column: bpCol },
      );
    });

    test('Multiple column BPs are hit on correct columns', async () => {
      const testProjectRoot = path.join(DATA_ROOT, 'columns');
      const scriptPath = path.join(testProjectRoot, 'src/script.ts');

      server = createServer({ root: testProjectRoot });
      server.listen(7890);

      const url = 'http://localhost:7890/index.html';

      const bpLine = 4;
      const bpCol1 = 16;
      const bpCol2 = 24;
      await dc.hitBreakpointUnverified(
        { url, webRoot: testProjectRoot },
        { path: scriptPath, line: bpLine, column: bpCol1 },
      );
      await dc.setBreakpointsRequest({
        source: { path: scriptPath },
        breakpoints: [{ line: bpLine, column: bpCol2 }],
      });
      await dc.continueTo('breakpoint', { line: bpLine, column: bpCol2 });
    });

    test.skip('BP col is adjusted to correct col', async () => {
      const testProjectRoot = path.join(DATA_ROOT, 'columns');
      const scriptPath = path.join(testProjectRoot, 'src/script.ts');

      server = createServer({ root: testProjectRoot });
      server.listen(7890);

      const url = 'http://localhost:7890/index.html';

      const bpLine = 4;
      const bpCol1 = 19;
      const correctBpCol1 = 16;
      const expectedLocation = { path: scriptPath, line: bpLine, column: correctBpCol1 };
      await dc.hitBreakpointUnverified(
        { url, webRoot: testProjectRoot },
        { path: scriptPath, line: bpLine, column: bpCol1 },
        expectedLocation,
      );
    });
  });
});
