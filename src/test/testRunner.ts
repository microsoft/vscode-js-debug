// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Mocha from 'mocha';
import * as glob from 'glob';
import { use } from 'chai';
import { join } from 'path';

use(require('chai-subset'));

function setupCoverage() {
  const NYC = require('nyc');
  const nyc = new NYC({
    cwd: join(__dirname, '..', '..', '..'),
    exclude: ['**/test/**', '.vscode-test/**'],
    reporter: ['text', 'html'],
    all: true,
    instrument: true,
    hookRequire: true,
    hookRunInContext: true,
    hookRunInThisContext: true,
  });

  nyc.reset();
  nyc.wrap();

  return nyc;
}

export async function run(): Promise<void> {
  const nyc = process.env.COVERAGE ? setupCoverage() : null;

  const runner = new Mocha({
    timeout: 2000000,
    grep: 'localSourceMapRepository',
    ...JSON.parse(process.env.PWA_TEST_OPTIONS || '{}'),
  });

  runner.useColors(true);

  // todo: retry failing tests https://github.com/microsoft/vscode-pwa/issues/28
  runner.retries(2);

  runner.addFile(join(__dirname, 'testIntegrationUtils'));
  runner.addFile(join(__dirname, 'infra/infra'));
  runner.addFile(join(__dirname, 'breakpoints/breakpointsTest'));
  runner.addFile(join(__dirname, 'browser/framesTest'));
  runner.addFile(join(__dirname, 'evaluate/evaluate'));
  runner.addFile(join(__dirname, 'sources/sourcesTest'));
  runner.addFile(join(__dirname, 'stacks/stacksTest'));
  runner.addFile(join(__dirname, 'threads/threadsTest'));
  runner.addFile(join(__dirname, 'variables/variablesTest'));
  runner.addFile(join(__dirname, 'console/consoleFormatTest'));
  runner.addFile(join(__dirname, 'console/consoleAPITest'));
  runner.addFile(join(__dirname, 'extension/nodeConfigurationProvidersTests'));

  for (const file of glob.sync('**/*.test.js', { cwd: __dirname })) {
    runner.addFile(join(__dirname, file));
  }

  try {
    await new Promise((resolve, reject) =>
      runner.run(failures =>
        failures ? reject(new Error(`${failures} tests failed`)) : resolve(),
      ),
    );
  } finally {
    if (nyc) {
      nyc.writeCoverageFile();
      nyc.report();
    }
  }
}
