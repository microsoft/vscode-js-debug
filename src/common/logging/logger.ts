/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable } from 'inversify';
import * as os from 'os';
import { packageName, packageVersion } from '../../configuration';
import { IDisposable } from '../events';
import { ILogger, ILoggerSetupOptions, ILogItem, ILogSink, LogLevel, LogTag } from '.';
import { TestLogSink } from './testLogSink';

/**
 * Ring buffer used to get logs to diagnose issues.
 */
class RingBuffer {
  private readonly items: ILogItem<unknown>[] = [];
  private i = 0;

  constructor(private readonly size = 512) {}

  public write(item: ILogItem<unknown>): void {
    this.items[this.i] = item;
    this.i = (this.i + 1) % this.size;
  }

  public read() {
    return this.items.slice(this.i).concat(this.items.slice(0, this.i));
  }
}

/**
 * Implementation of ILogger for the extension.
 */
@injectable()
export class Logger implements ILogger, IDisposable {
  /**
   * The target of the logger. Either a list of sinks, or a queue of items
   * to write once we get sinks.
   */
  private logTarget: { queue: ILogItem<unknown>[] } | { sinks: ILogSink[] } = { queue: [] };

  /**
   * Log buffer for replaying diagnostics.
   */
  private readonly logBuffer = new RingBuffer();

  /**
   * A no-op logger that never logs anything.
   */
  public static null = (() => {
    const logger = new Logger();
    logger.setup({ sinks: [] });
    return logger;
  })();

  /**
   * Creates a logger with the TestLogSink hooked up.
   */
  public static async test() {
    const logger = new Logger();
    logger.setup({ sinks: [new TestLogSink()], showWelcome: false });
    return logger;
  }

  /**
   * @inheritdoc
   */
  public info(tag: LogTag, msg?: string, metadata?: unknown): void {
    this.log({
      tag,
      timestamp: Date.now(),
      message: msg,
      metadata,
      level: LogLevel.Info,
    });
  }

  /**
   * @inheritdoc
   */
  public verbose(tag: LogTag, msg?: string, metadata?: unknown): void {
    this.log({
      tag,
      timestamp: Date.now(),
      message: msg,
      metadata,
      level: LogLevel.Verbose,
    });
  }

  /**
   * @inheritdoc
   */
  public warn(tag: LogTag, msg?: string, metadata?: unknown): void {
    this.log({
      tag,
      timestamp: Date.now(),
      message: msg,
      metadata,
      level: LogLevel.Warn,
    });
  }

  /**
   * @inheritdoc
   */
  public error(tag: LogTag, msg?: string, metadata?: unknown): void {
    this.log({
      tag,
      timestamp: Date.now(),
      message: msg,
      metadata,
      level: LogLevel.Error,
    });
  }

  /**
   * @inheritdoc
   */
  public fatal(tag: LogTag, msg?: string, metadata?: unknown): void {
    this.log({
      tag,
      timestamp: Date.now(),
      message: msg,
      metadata,
      level: LogLevel.Fatal,
    });
  }

  /**
   * Makes an assertion, *logging* if it failed.
   */
  public assert<T>(assertion: T | false | undefined | null, message: string): assertion is T {
    if (assertion === false || assertion === undefined || assertion === null) {
      this.error(LogTag.RuntimeAssertion, message, { error: new Error('Assertion failed') });

      if (process.env.JS_DEBUG_THROW_ASSERTIONS) {
        throw new Error(message);
      }

      debugger; // break when running in development
      return false;
    }

    return true;
  }

  /**
   * @inheritdoc
   */
  public log(data: ILogItem<unknown>): void {
    this.logBuffer.write(data);

    if ('queue' in this.logTarget) {
      this.logTarget.queue.push(data);
      return;
    }

    for (const sink of this.logTarget.sinks) {
      sink.write(data);
    }
  }

  /**
   * @inheritdog
   */
  public getRecentLogs() {
    return this.logBuffer.read();
  }

  /**
   * @inheritdoc
   */
  dispose(): void {
    if ('sinks' in this.logTarget) {
      for (const target of this.logTarget.sinks) {
        target.dispose();
      }
      this.logTarget = { queue: [] };
    }
  }

  /**
   * @inheritdoc
   */
  forTarget() {
    return this;
  }

  /**
   * Adds the given sinks to the loggers. Plays back any items buffered in the queue.
   */
  public async setup(options: ILoggerSetupOptions): Promise<void> {
    await Promise.all(options.sinks.map(s => s.setup()));

    if (options.showWelcome !== false) {
      const message = createWelcomeMessage();
      for (const sink of options.sinks) {
        sink.write(message);
      }
    }

    const prevTarget = this.logTarget;
    this.logTarget = { sinks: options.sinks.slice() };

    if ('sinks' in prevTarget) {
      prevTarget.sinks.forEach(s => s.dispose());
    } else {
      // intentionally re-`log()` instead of writing directly to sinks so that
      // and tag or level filtering is applied.
      prevTarget.queue.forEach(m => this.log(m));
    }
  }
}

const createWelcomeMessage = (): ILogItem<unknown> => ({
  timestamp: Date.now(),
  tag: LogTag.RuntimeWelcome,
  level: LogLevel.Info,
  message: `${packageName} v${packageVersion} started`,
  metadata: {
    os: `${os.platform()} ${os.arch()}`,
    nodeVersion: process.version,
    adapterVersion: packageVersion,
  },
});
