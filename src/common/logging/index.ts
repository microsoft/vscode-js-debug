/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as path from 'path';
import { IDisposable } from '../disposable';
import { ILoggingConfiguration } from '../../configuration';
import Dap from '../../dap/api';
import { ConsoleLogSink } from './consoleLogSink';
import { tmpdir } from 'os';
import { FileLogSink } from './fileLogSink';

export const enum LogLevel {
  Verbose = 0,
  Info,
  Warn,
  Error,
  Fatal,
  Never,
}

export enum LogTag {
  Runtime = 'runtime',
  RuntimeTarget = 'runtime.target',
  RuntimeWelcome = 'runtime.welcome',
  RuntimeException = 'runtime.exception',
  RuntimeSourceMap = 'runtime.sourcemap',
  CdpSend = 'cdp.send',
  CdpReceive = 'cdp.receive',
  DapSend = 'dap.send',
  DapReceive = 'dap.receive',
}

/**
 * List of all log tags.
 */
export const allLogTags = Object.keys(LogTag) as ReadonlyArray<keyof typeof LogTag>;

export interface ILogItem<T> {
  timestamp: number;
  message?: string;
  metadata?: T;
  tag: LogTag;
  level: LogLevel;
}

/**
 * Logger interface.
 */
export interface ILogger {
  log(item: ILogItem<any>): void;
  verbose(msg?: string, metadata?: any): void;
  warn(msg?: string, metadata?: any): void;
  error(msg?: string, metadata?: any): void;
}

/**
 * A place where log information can be written.
 */
export interface ILogSink extends IDisposable {
  /**
   * Lifecycle hook called before the sink starts being used.
   */
  setup(): Promise<void>;

  /**
   * Writes an item to the log sink.
   */
  write(item: ILogItem<any>): void;
}

/**
 * Setup options provided to MasterLogger instances.
 */
export interface ILoggerSetupOptions {
  tags?: ReadonlyArray<string>;
  showWelcome?: boolean;
  level: LogLevel;
  sinks: ReadonlyArray<ILogSink>;
}

const stringToLogLevel = (str: string) => {
  switch (str.toLowerCase()) {
    case 'verbose':
      return LogLevel.Verbose;
    case 'info':
      return LogLevel.Info;
    case 'warn':
      return LogLevel.Warn;
    case 'error':
      return LogLevel.Error;
    case 'fatal':
      return LogLevel.Fatal;
    default:
      throw new Error(`Unknown log level "${str}"`);
  }
};

/**
 * Fulfills the partial config to a full logging configuration.
 */
export function fulfillLoggerOptions(
  config?: boolean | Partial<ILoggingConfiguration>,
  logDir = tmpdir(),
): ILoggingConfiguration {
  if (config === false) {
    return { console: false, level: 'fatal', logFile: null, tags: [] };
  }

  const defaults: ILoggingConfiguration = {
    console: false,
    level: 'verbose',
    logFile: path.join(logDir, 'vscode-debugadapter.json'),
    tags: [],
  };

  if (config === true) {
    return defaults;
  }

  return { ...defaults, ...config };
}

/**
 * Creates logger setup options from the given configuration.
 */
export function resolveLoggerOptions(
  dap: Dap.Api,
  config: boolean | Partial<ILoggingConfiguration>,
): ILoggerSetupOptions {
  const fulfilled = fulfillLoggerOptions(config);
  const options = {
    tags: fulfilled.tags,
    level: fulfilled.level === undefined ? LogLevel.Verbose : stringToLogLevel(fulfilled.level),
    sinks: <ILogSink[]>[],
  };

  if (fulfilled.console) {
    options.sinks.push(new ConsoleLogSink(dap));
  }

  if (fulfilled.logFile) {
    options.sinks.push(new FileLogSink(fulfilled.logFile, dap));
  }

  return options;
}
