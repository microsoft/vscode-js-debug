/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ILogSink, ILogItem, LogLevel } from '.';
import Dap from '../../dap/api';
import Connection from '../../dap/connection';

/**
 * A log sink that writes to the console output.
 */
export class ConsoleLogSink implements ILogSink {
  constructor(private readonly dap: Dap.Api) {}

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
    const category =
      item.level > LogLevel.Error ? 'stderr' : item.level === LogLevel.Warn ? 'console' : 'stdout';
    let output = `[${getLogLevel(item.level)}@${getFormattedTimeString()}] [${item.tag}]`;

    if (item.message) {
      output += ` ${item.message}`;
    }

    if (item.metadata) {
      output += `: ${JSON.stringify(item.metadata)}`;
    }

    output += '\n';
    this.dap.output(Connection.omitLoggingFor({ category, output }));
  }
}

function getFormattedTimeString(): string {
  const d = new Date();
  const hourString = String(d.getUTCHours()).padStart(2, '0');
  const minuteString = String(d.getUTCMinutes()).padStart(2, '0');
  const secondString = String(d.getUTCSeconds()).padStart(2, '0');
  const millisecondString = String(d.getUTCMilliseconds()).padStart(3, '0');
  return `${hourString}:${minuteString}:${secondString}.${millisecondString}`;
}

function getLogLevel(level: LogLevel): string {
  switch (level) {
    case LogLevel.Fatal:
      return 'FATAL';
    case LogLevel.Error:
      return 'ERROR';
    case LogLevel.Warn:
      return 'WARN';
    case LogLevel.Info:
      return 'INFO';
    case LogLevel.Verbose:
      return 'VERB';
    default:
      return 'UNKNOWN';
  }
}
