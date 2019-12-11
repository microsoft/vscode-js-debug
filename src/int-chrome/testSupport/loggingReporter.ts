/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as mocha from 'mocha';
import * as events from 'events';

class LoggingReporter extends mocha.reporters.Spec {
  static alwaysDumpLogs = false;
  static logEE = new events.EventEmitter();

  private testLogs: string[] = [];
  private inTest = false;

  constructor(runner: any) {
    super(runner);

    LoggingReporter.logEE.on('log', msg => {
      if (this.inTest) {
        this.testLogs.push(msg);
      }
    });

    runner.on('test', () => {
      this.inTest = true;
      this.testLogs = [];
    });

    runner.on('pass', () => {
      this.inTest = false;

      if (LoggingReporter.alwaysDumpLogs) {
        this.dumpLogs();
      }
    });

    runner.on('fail', () => {
      this.inTest = false;
      this.dumpLogs();

      // console.log(new Date().toISOString().split(/[TZ]/)[1] + ' Finished'); // TODO@rob
    });
  }

  private dumpLogs(): void {
    this.testLogs.forEach(msg => {
      console.log(msg);
    });
  }
}

export = LoggingReporter;
