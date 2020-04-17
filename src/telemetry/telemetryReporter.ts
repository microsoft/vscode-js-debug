/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IDisposable } from '../common/disposable';
import { LogFunctions, IRPCMetricsAndErrorsMap } from './classification';
import Dap from '../dap/api';
import { IEvent } from '../common/events';

// For each logger that takes an IRPCOperation, an OpsBatchReporter
export type Batchable = {
  [K in keyof LogFunctions]: LogFunctions[K] extends (metrics: IRPCMetricsAndErrorsMap) => void
    ? K
    : never;
}[keyof LogFunctions];

export interface ITelemetryReporter extends IDisposable {
  readonly onFlush: IEvent<void>;

  /**
   * Reports a telemetry event.
   */
  report<K extends keyof LogFunctions>(key: K, ...args: Parameters<LogFunctions[K]>): void;

  /**
   * Reports that an operation completed.
   * @param key - General type of operation
   * @param method - Operation method call
   * @param duration - How long the method call took
   * @param error - Any error that occurred
   */
  reportOperation(key: Batchable, method: string, duration: number, error?: Error): void;

  /**
   * Attaches the reporter to output to the given DAP connection.
   */
  attachDap(dap: Dap.Api): void;

  /**
   * Flushes all pending batch writes.
   */
  flush(): void;
}

export const ITelemetryReporter = Symbol('ITelemetryReporter');
