/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ILogSink, ILogItem, LogLevel } from '.';

/**
 * A log sink for use in testing that throws any errorful data, and writes
 * other data to the console.
 */
export class TestLogSink implements ILogSink {
  /**
   * @inheritdoc
   */
  public async setup() {
    // no-op
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    // no-op
  }

  /**
   * @inheritdoc
   */
  public write(item: ILogItem<unknown>): void {
    if (item.level > LogLevel.Warn) {
      throw new Error(item.message);
    } else {
      console.log(JSON.stringify(item));
    }
  }
}
