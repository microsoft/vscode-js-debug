// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as path from 'path';
import { createServer } from 'http-server';

import * as testSetup from './testSetup';
import { HttpOrHttpsServer } from './types/server';
import { ExtendedDebugClient } from './testSupport/debugClient';
import { chromeLaunchConfigDefaults } from '../configuration';

suite('BreakOnLoad', () => {
  const DATA_ROOT = testSetup.DATA_ROOT;

  let dc: ExtendedDebugClient;
  setup(function() {
    return testSetup
      .setup(this, {
        sourceMapPathOverrides: chromeLaunchConfigDefaults.sourceMapPathOverrides,
      })
      .then(_dc => (dc = _dc));
  });

  let server: HttpOrHttpsServer | null;
  teardown(() => {
    if (server) {
      server.close(err => console.log('Error closing server in teardown: ' + (err && err.message)));
      server = null;
    }

    return testSetup.teardown();
  });

  // this function is to help when launching and setting a breakpoint
  // currently, the chrome debug adapter, when launching in instrument mode and setting a breakpoint at (1, 1)
  // the breakpoint is not yet 'hit' so the reason is given as 'debugger_statement'
  // https://github.com/Microsoft/vscode-chrome-debug-core/blob/90797bc4a3599b0a7c0f197efe10ef7fab8442fd/src/chrome/chromeDebugAdapter.ts#L692
  // so we don't want to use hitBreakpointUnverified function because it specifically checks for 'breakpoint' as the reason
  function launchWithUrlAndSetBreakpoints(
    url: string,
    projectRoot: string,
    scriptPath: string,
    lineNum: number,
    colNum: number,
  ): Promise<any> {
    return Promise.all([
      dc.launch({ url: url, webRoot: projectRoot }),
      dc
        .waitForEvent('initialized')
        .then(_event => {
          return dc.setBreakpointsRequest({
            lines: [lineNum],
            breakpoints: [{ line: lineNum, column: colNum }],
            source: { path: scriptPath },
          });
        })
        .then(_response => {
          return dc.configurationDoneRequest();
        }),
    ]);
  }

  suite('TypeScript Project with SourceMaps', () => {
    test('Hits a single breakpoint in a file on load', async () => {
      const testProjectRoot = path.join(DATA_ROOT, 'breakOnLoad_sourceMaps');
      const scriptPath = path.join(testProjectRoot, 'src/script.ts');

      server = createServer({ root: testProjectRoot });
      server.listen(7890);

      const url = 'http://localhost:7890/index.html';

      const bpLine = 3;
      const bpCol = 11;

      await dc.hitBreakpointUnverified(
        { url, webRoot: testProjectRoot },
        { path: scriptPath, line: bpLine, column: bpCol },
      );
    });

    test('Hits multiple breakpoints in a file on load', async () => {
      const testProjectRoot = path.join(DATA_ROOT, 'breakOnLoad_sourceMaps');
      const scriptPath = path.join(testProjectRoot, 'src/script.ts');

      server = createServer({ root: testProjectRoot });
      server.listen(7890);

      const url = 'http://localhost:7890/index.html';

      const bp1Line = 3;
      const bp1Col = 11;
      const bp2Line = 6;

      await dc.hitBreakpointUnverified(
        { url, webRoot: testProjectRoot },
        { path: scriptPath, line: bp1Line, column: bp1Col },
      );
      await dc.setBreakpointsRequest({
        source: { path: scriptPath },
        breakpoints: [{ line: bp2Line }],
      });
      await dc.continueTo('breakpoint', { line: bp2Line });
    });

    test('Hits a breakpoint at (1,1) in a file on load', async () => {
      const testProjectRoot = path.join(DATA_ROOT, 'breakOnLoad_sourceMaps');
      const scriptPath = path.join(testProjectRoot, 'src/script.ts');

      server = createServer({ root: testProjectRoot });
      server.listen(7890);

      const url = 'http://localhost:7890/index.html';

      const bpLine = 1;
      const bpCol = 1;

      await launchWithUrlAndSetBreakpoints(url, testProjectRoot, scriptPath, bpLine, bpCol);
      await dc.assertStoppedLocation('breakpoint', {
        path: scriptPath,
        line: bpLine,
        column: bpCol,
      });
    });

    test('Hits a breakpoint in the first line in a file on load', async () => {
      const testProjectRoot = path.join(DATA_ROOT, 'breakOnLoad_sourceMaps');
      const scriptPath = path.join(testProjectRoot, 'src/script.ts');

      server = createServer({ root: testProjectRoot });
      server.listen(7890);

      const url = 'http://localhost:7890/index.html';

      const bpLine = 1;
      const bpCol = 34;

      await dc.hitBreakpointUnverified(
        { url, webRoot: testProjectRoot },
        { path: scriptPath, line: bpLine, column: bpCol },
      );
    });
  });

  suite('Simple JavaScript Project', () => {
    test('Hits a single breakpoint in a file on load', async () => {
      const testProjectRoot = path.join(DATA_ROOT, 'breakOnLoad_javaScript');
      const scriptPath = path.join(testProjectRoot, 'src/script.js');

      server = createServer({ root: testProjectRoot });
      server.listen(7890);

      const url = 'http://localhost:7890/index.html';

      const bpLine = 3;
      const bpCol = 12;

      await dc.hitBreakpointUnverified(
        { url, webRoot: testProjectRoot },
        { path: scriptPath, line: bpLine, column: bpCol },
      );
    });

    test('Hits multiple breakpoints in a file on load', async () => {
      const testProjectRoot = path.join(DATA_ROOT, 'breakOnLoad_javaScript');
      const scriptPath = path.join(testProjectRoot, 'src/script.js');

      server = createServer({ root: testProjectRoot });
      server.listen(7890);

      const url = 'http://localhost:7890/index.html';

      const bp1Line = 3;
      const bp1Col = 12;
      const bp2Line = 6;

      await dc.hitBreakpointUnverified(
        { url, webRoot: testProjectRoot },
        { path: scriptPath, line: bp1Line, column: bp1Col },
      );
      await dc.setBreakpointsRequest({
        source: { path: scriptPath },
        breakpoints: [{ line: bp2Line }],
      });
      await dc.continueTo('breakpoint', { line: bp2Line });
    });

    test('Hits a breakpoint at (1,1) in a file on load', async () => {
      const testProjectRoot = path.join(DATA_ROOT, 'breakOnLoad_javaScript');
      const scriptPath = path.join(testProjectRoot, 'src/script.js');

      server = createServer({ root: testProjectRoot });
      server.listen(7890);

      const url = 'http://localhost:7890/index.html';

      const bpLine = 1;
      const bpCol = 1;

      await launchWithUrlAndSetBreakpoints(url, testProjectRoot, scriptPath, bpLine, bpCol);
      await dc.assertStoppedLocation('breakpoint', {
        path: scriptPath,
        line: bpLine,
        column: bpCol,
      });
    });

    test('Hits a breakpoint in the first line in a file on load', async () => {
      const testProjectRoot = path.join(DATA_ROOT, 'breakOnLoad_javaScript');
      const scriptPath = path.join(testProjectRoot, 'src/script.js');

      server = createServer({ root: testProjectRoot });
      server.listen(7890);

      const url = 'http://localhost:7890/index.html';

      const bpLine = 1;
      const bpCol = 35;

      await dc.hitBreakpointUnverified(
        { url, webRoot: testProjectRoot },
        { path: scriptPath, line: bpLine, column: bpCol },
      );
    });

    test('Hits breakpoints on the first line of two scripts', async () => {
      const testProjectRoot = path.join(DATA_ROOT, 'breakOnLoad_javaScript');
      const scriptPath = path.join(testProjectRoot, 'src/script.js');
      const script2Path = path.join(testProjectRoot, 'src/script2.js');

      server = createServer({ root: testProjectRoot });
      server.listen(7890);

      const url = 'http://localhost:7890/index.html';

      const bpLine = 1;
      const bpCol = 1;

      await launchWithUrlAndSetBreakpoints(url, testProjectRoot, scriptPath, bpLine, bpCol);
      await dc.assertStoppedLocation('breakpoint', {
        path: scriptPath,
        line: bpLine,
        column: bpCol,
      });
      await dc.setBreakpointsRequest({
        lines: [bpLine],
        breakpoints: [{ line: bpLine, column: bpCol }],
        source: { path: script2Path },
      });
      await dc.continueRequest();
      await dc.assertStoppedLocation('breakpoint', {
        path: script2Path,
        line: bpLine,
        column: bpCol,
      });
    });
  });

  suite('Instrument Webpack Project', () => {
    test('Hits a single breakpoint in a file on load', async () => {
      const testProjectRoot = path.join(DATA_ROOT, 'breakOnLoad_webpack');
      const scriptPath = path.join(testProjectRoot, 'src/script.js');

      server = createServer({ root: testProjectRoot });
      server.listen(7890);

      const url = 'http://localhost:7890/dist/index.html';

      const bpLine = 3;
      const bpCol = 1;

      await dc.hitBreakpointUnverified(
        { url, webRoot: testProjectRoot },
        { path: scriptPath, line: bpLine, column: bpCol },
      );
    });

    test('Hits multiple breakpoints in a file on load', async () => {
      const testProjectRoot = path.join(DATA_ROOT, 'breakOnLoad_webpack');
      const scriptPath = path.join(testProjectRoot, 'src/script.js');

      server = createServer({ root: testProjectRoot });
      server.listen(7890);

      const url = 'http://localhost:7890/dist/index.html';

      // For some reason, column numbers > don't work perfectly with webpack
      const bp1Line = 3;
      const bp1Col = 1;
      const bp2Line = 5;
      const bp2Col = 1;

      await dc.hitBreakpointUnverified(
        { url, webRoot: testProjectRoot },
        { path: scriptPath, line: bp1Line, column: bp1Col },
      );
      await dc.setBreakpointsRequest({
        source: { path: scriptPath },
        breakpoints: [{ line: bp2Line, column: bp2Col }],
      });
      await dc.continueTo('breakpoint', { line: bp2Line, column: bp2Col });
    });

    test('Hits a breakpoint at (1,1) in a file on load', async () => {
      const testProjectRoot = path.join(DATA_ROOT, 'breakOnLoad_webpack');
      const scriptPath = path.join(testProjectRoot, 'src/script.js');

      server = createServer({ root: testProjectRoot });
      server.listen(7890);

      const url = 'http://localhost:7890/dist/index.html';

      const bpLine = 1;
      const bpCol = 1;

      await dc.hitBreakpointUnverified(
        { url, webRoot: testProjectRoot },
        { path: scriptPath, line: bpLine, column: bpCol },
      );
    });
  });
});
