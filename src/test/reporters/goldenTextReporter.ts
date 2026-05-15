/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as mocha from 'mocha';
import { IGoldenReporterTextTest } from './goldenTextReporterUtils';

class GoldenTextReporter extends mocha.reporters.Spec {
  static alwaysDumpGoldenText = process.env['DUMP_GOLDEN_TEXT'];

  constructor(runner: any) {
    super(runner);

    runner.on('pass', (test: IGoldenReporterTextTest) => {
      if (GoldenTextReporter.alwaysDumpGoldenText) {
        return this.dumpGoldenText(test);
      }
    });

    runner.on('fail', (test: IGoldenReporterTextTest) => {
      return this.dumpGoldenText(test);
    });
  }

  private async dumpGoldenText(test: IGoldenReporterTextTest): Promise<void> {
    if (!(test instanceof mocha.Test)) return;

    if (test.goldenText && test.goldenText.hasNonAssertedLogs()) {
      console.error('=== Golden Text ===');
      console.error(test.goldenText.getOutput());
    }
  }
}

// Must be default export
export = GoldenTextReporter;
