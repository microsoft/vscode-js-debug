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
import { existsSync } from 'fs';

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
  RuntimeSourceCreate = 'runtime.sourcecreate',
  RuntimeAssertion = 'runtime.assertion',
  RuntimeLaunch = 'runtime.launch',
  RuntimeTarget = 'runtime.target',
  RuntimeWelcome = 'runtime.welcome',
  RuntimeException = 'runtime.exception',
  RuntimeSourceMap = 'runtime.sourcemap',
  SourceMapParsing = 'sourcemap.parsing',
  PerfFunction = 'perf.function',
  CdpSend = 'cdp.send',
  CdpReceive = 'cdp.receive',
  DapSend = 'dap.send',
  DapReceive = 'dap.receive',
  Internal = 'internal',
}

/**
 * List of all log tags.
 */
export const allLogTags = Object.keys(LogTag) as ReadonlyArray<keyof typeof LogTag>;

export interface ILogItem<T = unknown> {
  timestamp: number;
  message?: string;
  metadata?: T;
  tag: LogTag;
  level: LogLevel;
}

export const ILogger = Symbol('ILogger');

/**
 * Logger interface.
 */
export interface ILogger extends IDisposable {
  setup(options: ILoggerSetupOptions): Promise<void>;
  log(item: ILogItem<unknown>): void;
  info(tag: LogTag, msg?: string, metadata?: unknown): void;
  verbose(tag: LogTag, msg?: string, metadata?: unknown): void;
  warn(tag: LogTag, msg?: string, metadata?: unknown): void;
  error(tag: LogTag, msg?: string, metadata?: unknown): void;
  fatal(tag: LogTag, msg?: string, metadata?: unknown): void;

  /**
   * Creates an instance of the logger for a child session. The logger
   * may simply return the current instance if it does not need to do anything.
   */
  forTarget(): ILogger;

  /**
   * Makes an assertion, *logging* if it failed.
   */
  assert<T>(assertion: T | false | undefined | null, message: string): assertion is T;
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
  write(item: ILogItem<unknown>): void;
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
    return { console: false, level: 'fatal', stdio: false, logFile: null, tags: [] };
  }

  let logFile: string;
  let i = 0;
  do {
    logFile = path.join(logDir, `vscode-debugadapter-${i++}.json`);
  } while (existsSync(logFile));

  const defaults: ILoggingConfiguration = {
    console: false,
    level: 'verbose',
    stdio: true,
    logFile,
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
    sinks: [] as ILogSink[],
  };

  if (fulfilled.console) {
    options.sinks.push(new ConsoleLogSink(dap));
  }

  if (fulfilled.logFile) {
    options.sinks.push(new FileLogSink(fulfilled.logFile, dap));
  }

  return options;
}
