/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ILogSink, ILogItem, LogLevel } from '.';
import signale from 'signale';

/**
 * A log sink that writes to the console output of the current process
 */
export class StdoutLogSink implements ILogSink {
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
    let output = `[${item.tag}]`;

    if (item.message) {
      output += ` ${item.message}`;
    }

    if (item.metadata) {
      output += `: ${JSON.stringify(item.metadata)}`;
    }

    getLogFn(item.level).call(signale, output);
  }
}

function getLogFn(level: LogLevel): signale.LoggerFunc {
  switch (level) {
    case LogLevel.Fatal:
      return signale.fatal;
    case LogLevel.Error:
      return signale.error;
    case LogLevel.Warn:
      return signale.warn;
    case LogLevel.Info:
      return signale.info;
    case LogLevel.Verbose:
      return signale.debug;
    default:
      return signale.debug;
  }
}
