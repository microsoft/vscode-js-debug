/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

// @ts-ignore
import allTests from '**/*.test.ts';
import Mocha from 'mocha';
import { join } from 'path';
import LoggingReporter from './reporters/logTestReporter';
import './testHooks';

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

  const mochaOpts: Mocha.MochaOptions = {
    timeout: 10 * 1000,
    color: true,
    ...JSON.parse(process.env.PWA_TEST_OPTIONS || '{}'),
  };

  if (process.env.ONLY_MINSPEC === 'true') {
    mochaOpts.grep = 'node runtime'; // may eventually want a more dynamic system
  }

  const grep = mochaOpts.grep || (mochaOpts as Record<string, unknown>).g;
  if (grep) {
    mochaOpts.grep = new RegExp(String(grep), 'i');
  }

  mochaOpts.reporter = LoggingReporter;
  if (process.env.BUILD_ARTIFACTSTAGINGDIRECTORY) {
    mochaOpts.reporterOptions = {
      reporterEnabled: `mocha-junit-reporter`,
      mochaJunitReporterReporterOptions: {
        testsuitesTitle: `tests ${process.platform}`,
        mochaFile: join(
          process.env.BUILD_ARTIFACTSTAGINGDIRECTORY,
          `test-results/TEST-${process.platform}-test-results.xml`,
        ),
      },
    };
  }

  const runner = new Mocha(mochaOpts);
  const addFile = async (file: string, doImport: () => Promise<unknown>) => {
    runner.suite.emit(Mocha.Suite.constants.EVENT_FILE_PRE_REQUIRE, globalThis, file, runner);
    const m = await doImport();
    runner.suite.emit(Mocha.Suite.constants.EVENT_FILE_REQUIRE, m, file, runner);
    runner.suite.emit(Mocha.Suite.constants.EVENT_FILE_POST_REQUIRE, globalThis, file, runner);
  };

  // todo: retry failing tests https://github.com/microsoft/vscode-pwa/issues/28
  if (process.env.RETRY_TESTS) {
    runner.retries(Number(process.env.RETRY_TESTS));
  }

  const rel = (f: string) => join(__dirname, `${f}.ts`);
  if (process.env.FRAMEWORK_TESTS) {
    await addFile(rel('framework/reactTest'), () => import('./framework/reactTest'));
  } else {
    await addFile(rel('testIntegrationUtils'), () => import('./testIntegrationUtils'));
    await addFile(rel('infra/infra'), () => import('./infra/infra'));
    await addFile(
      rel('breakpoints/breakpointsTest'),
      () => import('./breakpoints/breakpointsTest'),
    );
    await addFile(rel('browser/framesTest'), () => import('./browser/framesTest'));
    await addFile(
      rel('browser/blazorSourcePathResolverTest'),
      () => import('./browser/blazorSourcePathResolverTest'),
    );
    await addFile(rel('evaluate/evaluate'), () => import('./evaluate/evaluate'));
    await addFile(rel('sources/sourcesTest'), () => import('./sources/sourcesTest'));
    await addFile(rel('stacks/stacksTest'), () => import('./stacks/stacksTest'));
    await addFile(rel('threads/threadsTest'), () => import('./threads/threadsTest'));
    await addFile(rel('variables/variablesTest'), () => import('./variables/variablesTest'));
    await addFile(rel('console/consoleFormatTest'), () => import('./console/consoleFormatTest'));
    await addFile(rel('console/consoleAPITest'), () => import('./console/consoleAPITest'));

    for (const [path, imp] of allTests) {
      await addFile(rel(path), imp);
    }
  }

  try {
    await new Promise((resolve, reject) =>
      runner.run(failures =>
        failures ? reject(new Error(`${failures} tests failed`)) : resolve(undefined)
      )
    );
  } finally {
    if (nyc) {
      nyc.writeCoverageFile();
      await nyc.report();
    }
  }
}
