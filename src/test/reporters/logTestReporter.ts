/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as mocha from 'mocha';
import { TestWithLogfile, getLogFileForTest as getLogPathForTest } from './logReporterUtils';

class LoggingReporter extends mocha.reporters.Spec {
  static alwaysDumpLogs = process.env['DUMP_LOGS'];

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
    console.log(`##vso[build.uploadlog]${logPath}`);
  }
}

// Must be default export
export = LoggingReporter;
