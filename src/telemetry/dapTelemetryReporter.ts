/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Dap from '../dap/api';
import { ReporterBatcher } from './opsReportBatch';
import { LogFunctions, createLoggers } from './classification';
import { mapValues } from '../common/objUtils';
import { EventEmitter } from '../common/events';
import { Batchable, ITelemetryReporter } from './telemetryReporter';
import { injectable } from 'inversify';

/**
 * A telemetry reporter is a logging interface that pushes telemetry events
 * over DAP.
 */
@injectable()
export class DapTelemetryReporter implements ITelemetryReporter {
  /**
   * How often to flush telemetry batches.
   */
  private static batchFlushInterval = 5000;

  /**
   * Either a connected DAP connection, or telemetry queue.
   */
  private target: Dap.Api | Dap.OutputEventParams[] = [];

  private readonly flushEmitter = new EventEmitter<void>();
  private readonly loggers = createLoggers(params => this.pushOutput(params));
  private readonly batchFlushTimeout: { [K in Batchable]?: NodeJS.Timeout } = {};
  private readonly batchers: { [K in Batchable]: ReporterBatcher } = {
    dapOperation: new ReporterBatcher(),
    cdpOperation: new ReporterBatcher(),
  };

  /**
   * Event that fires when the reporter wants to flush telemetry. Consumers
   * can hook into this to lazily provide pre-shutdown information.
   */
  public readonly onFlush = this.flushEmitter.event;

  /**
   * @inheritdoc
   */
  public report<K extends keyof LogFunctions>(key: K, ...args: Parameters<LogFunctions[K]>) {
    const fn = this.loggers[key];
    // Weirdly, TS doesn't seem to be infer that args is the
    // same Parameters<Fn[K]> that fn (Fn[K]) is.
    ((fn as unknown) as (...args: unknown[]) => void)(...args);
  }

  /**
   * @inheritdoc
   */
  public reportOperation(key: Batchable, method: string, duration: number, error?: Error) {
    this.batchers[key].add(method, duration, error);

    if (this.batchFlushTimeout[key] === undefined) {
      this.batchFlushTimeout[key] = setTimeout(() => {
        this.report(key, this.batchers[key].flush());
        this.batchFlushTimeout[key] = undefined;
      }, DapTelemetryReporter.batchFlushInterval);
    }
  }

  /**
   * @inheritdoc
   */
  public attachDap(dap: Dap.Api) {
    if (this.target instanceof Array) {
      this.target.forEach(event => dap.output(event));
    }

    this.target = dap;
  }

  /**
   * @inheritdoc
   */
  public flush() {
    this.flushEmitter.fire();

    const pending = Object.entries(this.batchFlushTimeout) as [Batchable, NodeJS.Timeout][];
    for (const [key, value] of pending) {
      const metrics = this.batchers[key].flush();
      if (metrics.length) {
        this.report(key, metrics);
      }

      this.batchFlushTimeout[key] = undefined;
      clearTimeout(value);
    }
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    for (const timeout of Object.values(this.batchFlushTimeout)) {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private pushOutput(event: Dap.OutputEventParams) {
    event.data = mapOutput(event.data) as object;
    if (this.target instanceof Array) {
      this.target.push(event);
    } else {
      this.target.output(event);
    }
  }
}

const mapOutput = (obj: unknown): unknown => {
  if (typeof obj === 'number') {
    return Number(obj.toFixed(1)); // compress floating point numbers
  }

  if (typeof obj !== 'object' || !obj) {
    return obj;
  }

  // Replace errors with their sanitized details
  if (obj instanceof Error) {
    return extractErrorDetails(obj);
  }

  if (obj instanceof Array) {
    return obj.map(mapOutput);
  }

  return mapValues(obj as { [key: string]: unknown }, mapOutput);
};

// Pattern: The pattern recognizes file paths and captures the file name and the colon at the end.
// Next line is a sample path aligned with the regexp parts that recognize it/match it. () is for the capture group
//                                C  :     \  foo      \  (in.js:)
//                                C  :     \  foo\ble  \  (fi.ts:)
const extractFileNamePattern = /(?:[A-z]:)?(?:[\\/][^:]*)+[\\/]([^:]*:)/g;

interface IErrorTelemetryProperties {
  message: string | undefined;
  name: string | undefined;
  stack: string | undefined;
}

/**
 * Converts the Error to an nice object with any private paths replaced.
 */
function extractErrorDetails(e: Error): { error: IErrorTelemetryProperties } {
  const message = String(e.message);
  const name = String(e.name);

  extractFileNamePattern.lastIndex = 0;

  const stack =
    typeof e.stack === 'string' ? e.stack.replace(extractFileNamePattern, '$1') : undefined;

  return { error: { message, name, stack } };
}
