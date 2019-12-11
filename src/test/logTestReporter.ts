// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as mocha from 'mocha';
import * as fs from 'fs';
import * as util from 'util';
import { TestWithLogfile, getLogFileForTest as getLogPathForTest } from './logReporterUtils';

class LoggingReporter extends mocha.reporters.Spec {
  static alwaysDumpLogs = false;

  constructor(runner: any) {
    super(runner);

    runner.on('pass', (test: TestWithLogfile) => {
      if (LoggingReporter.alwaysDumpLogs) {
        return this.dumpLogs(test);
      }
    });

    runner.on('fail', (test: TestWithLogfile) => {
      return this.dumpLogs(test);
    });
  }

  private async dumpLogs(test: mocha.Runnable): Promise<void> {
    if (!(test instanceof mocha.Test)) return;

    const logPath = getLogPathForTest(test.fullTitle());
    try {
      const contents = (await util.promisify(fs.readFile)(logPath)).toString();
      console.log(`##vso[build.uploadlog]${logPath}`);
      contents.split('\n').forEach(s => console.error(s.substr(0, 1000)));
    } catch (e) {}
  }
}

// Must be default export
export = LoggingReporter;
