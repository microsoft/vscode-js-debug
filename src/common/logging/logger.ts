/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IDisposable } from '../events';
import { injectable } from 'inversify';
import * as os from 'os';
import { ILogger, ILogItem, ILogSink, ILoggerSetupOptions, LogLevel, LogTag, allLogTags } from '.';
import { TestLogSink } from './testLogSink';
import { packageName, packageVersion } from '../../configuration';

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
   * Minimum log level.
   */
  private minLevel = LogLevel.Verbose;

  /**
   * Log tag filter.
   */
  private tags?: ReadonlySet<LogTag>;

  /**
   * A no-op logger that never logs anything.
   */
  public static null = (() => {
    const logger = new Logger();
    logger.setup({ sinks: [], level: LogLevel.Fatal + 1 });
    return logger;
  })();

  /**
   * Creates a logger with the TestLogSink hooked up.
   */
  public static async test(level: LogLevel = LogLevel.Info) {
    const logger = new Logger();
    logger.setup({ sinks: [new TestLogSink()], level, showWelcome: false });
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
    if ('queue' in this.logTarget) {
      this.logTarget.queue.push(data);
      return;
    }

    if (data.level < this.minLevel) {
      return;
    }

    if (this.tags && !this.tags.has(data.tag)) {
      return;
    }

    for (const sink of this.logTarget.sinks) {
      sink.write(data);
    }
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
    this.minLevel = options.level;

    if (options.tags && options.tags.length) {
      // Add all log tags that equal or are children of the one given in the
      // options. For instance, `cdp` adds the tags `cdp`, `cdp.send`, etc.
      this.tags = new Set(
        options.tags
          .map(src =>
            allLogTags
              .map(key => LogTag[key])
              .filter(tag => tag === src || tag.startsWith(`${src}.`)),
          )
          .reduce((acc, tags) => [...acc, ...tags], []),
      );
    } else {
      this.tags = undefined;
    }

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
