/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ILogger, ILogItem, LogTag, LogLevel } from '.';

export class ProxyLogger implements ILogger {
  private target?: { logger: ILogger } | { queue: ILogItem[] } = { queue: [] };

  /**
   * Connects this logger to the given instance.
   */
  public connectTo(logger: ILogger) {
    this.target = { logger };
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
   * @inheritdoc
   */
  public log(data: ILogItem<unknown>): void {
    if (!this.target) {
      // no-op
    } else if ('queue' in this.target) {
      this.target.queue.push(data);
    } else {
      this.target.logger.log(data);
    }
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
  public setup(): never {
    throw new Error('A ProxyLogger cannot be setup()');
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    this.target = undefined;
  }

  /**
   * @inheritdoc
   */
  public forTarget() {
    return new ProxyLogger();
  }
}
