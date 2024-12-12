/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { randomBytes } from 'crypto';
import { tmpdir } from 'os';
import * as path from 'path';
import { ILoggingConfiguration } from '../../configuration';
import Dap from '../../dap/api';
import { IDisposable } from '../disposable';
import { FileLogSink } from './fileLogSink';

export const enum LogLevel {
  Verbose = 0,
  Info,
  Warn,
  Error,
  Fatal,
  Never,
}

export const enum LogTag {
  Runtime = 'runtime',
  RuntimeSourceCreate = 'runtime.sourcecreate',
  RuntimeAssertion = 'runtime.assertion',
  RuntimeLaunch = 'runtime.launch',
  RuntimeTarget = 'runtime.target',
  RuntimeWelcome = 'runtime.welcome',
  RuntimeException = 'runtime.exception',
  RuntimeSourceMap = 'runtime.sourcemap',
  RuntimeBreakpoints = 'runtime.breakpoints',
  SourceMapParsing = 'sourcemap.parsing',
  PerfFunction = 'perf.function',
  CdpSend = 'cdp.send',
  CdpReceive = 'cdp.receive',
  ProxyActivity = 'proxyActivity',
  DapSend = 'dap.send',
  DapReceive = 'dap.receive',
  Internal = 'internal',
}

const logTabObj: { [K in LogTag]: null } = {
  [LogTag.Runtime]: null,
  [LogTag.RuntimeSourceCreate]: null,
  [LogTag.RuntimeAssertion]: null,
  [LogTag.RuntimeLaunch]: null,
  [LogTag.RuntimeTarget]: null,
  [LogTag.RuntimeWelcome]: null,
  [LogTag.RuntimeException]: null,
  [LogTag.RuntimeSourceMap]: null,
  [LogTag.RuntimeBreakpoints]: null,
  [LogTag.SourceMapParsing]: null,
  [LogTag.PerfFunction]: null,
  [LogTag.CdpSend]: null,
  [LogTag.CdpReceive]: null,
  [LogTag.DapSend]: null,
  [LogTag.DapReceive]: null,
  [LogTag.Internal]: null,
  [LogTag.ProxyActivity]: null,
};

/**
 * List of all log tags.
 */
export const allLogTags = Object.keys(logTabObj) as ReadonlyArray<LogTag>;

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

  /**
   * Gets recently logged items.
   */
  getRecentLogs(): ILogItem<unknown>[];
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
  showWelcome?: boolean;
  sinks: ReadonlyArray<ILogSink>;
}

/**
 * Fulfills the partial config to a full logging configuration.
 */
export function fulfillLoggerOptions(
  config?: boolean | Partial<ILoggingConfiguration>,
  logDir = tmpdir(),
): ILoggingConfiguration {
  if (config === false) {
    return { stdio: false, logFile: null };
  }

  const defaults: ILoggingConfiguration = {
    stdio: true,
    logFile: path.join(logDir, `vscode-debugadapter-${randomBytes(4).toString('hex')}.json`),
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
    sinks: [] as ILogSink[],
  };

  if (fulfilled.logFile) {
    options.sinks.push(new FileLogSink(fulfilled.logFile, dap));
  }

  return options;
}
