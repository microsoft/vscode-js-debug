// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Dap from '../dap/api';
import { HighResolutionTime, calculateElapsedTime } from '../utils/performance';
import { OpsReportBatcher, UnbatchedOpReport } from './opsReportBatch';
import { EventEmitter } from '../common/events';

export type TelemetryEntityProperties = object;
export type OutcomeAndTime = { time: number, succesful: boolean };

enum RequestOutcome {
  Succesful,
  Failed
}

export class DapRequestTelemetryReporter {
  private readonly _rawTelemetryReporter: RawTelemetryReporterToDap;

  public constructor(dap: Dap.Api) {
    this._rawTelemetryReporter = new RawTelemetryReporterToDap(dap);
  }

  reportErrorWhileHandlingDapMessage(dapCommand: string, receivedTime: HighResolutionTime, error: unknown) {
    this.reportWithElapsedTime(receivedTime, dapCommand, extractErrorDetails(error), RequestOutcome.Failed);
  }

  reportSuccesfullyHandledDapMessage(dapCommand: string, receivedTime: HighResolutionTime) {
    this.reportWithElapsedTime(receivedTime, dapCommand, {}, RequestOutcome.Succesful);
  }

  private reportWithElapsedTime(receivedTime: [number, number], dapCommand: string, properties: TelemetryEntityProperties, outcome: RequestOutcome) {
    const elapsedTime = calculateElapsedTime(receivedTime);
    this._rawTelemetryReporter.report('dap/' + dapCommand, { ...properties, time: elapsedTime, succesful: outcome === RequestOutcome.Succesful });
  }
}

export class CdpTelemetryReporter {
  private readonly _batcher = new OpsReportBatcher();

  public constructor(private readonly _rawTelemetryReporter: RawTelemetryReporter) {
    this._rawTelemetryReporter.flush.event(() => {
      this._rawTelemetryReporter.report('cdpOperations', this._batcher.batched());
    });
  }

  reportErrorWhileHandlingEvent(cdpEventName: string, receivedTime: HighResolutionTime, error: unknown) {
    this.reportWithElapsedTime(receivedTime, cdpEventName, extractErrorDetails(error), RequestOutcome.Failed);
  }

  reportSuccesfullyHandledEvent(cdpEventName: string, receivedTime: HighResolutionTime) {
    this.reportWithElapsedTime(receivedTime, cdpEventName, {}, RequestOutcome.Succesful);
  }

  private reportWithElapsedTime(receivedTime: HighResolutionTime, cdpEventName: string, properties: TelemetryEntityProperties, outcome: RequestOutcome) {
    // Floating point numbers use too much space and we don't need that much precision, we use integers to use less space when batching timings
    const elapsedTime = Math.ceil(calculateElapsedTime(receivedTime));

    // CDP generates a lot of operations, so instead of reporting them one by one, we batch them all together
    this._batcher.add(new UnbatchedOpReport('cdp/' + cdpEventName, { ...properties, time: elapsedTime, succesful: outcome === RequestOutcome.Succesful }));
  }
}

export function isRawTelemetryReporter(unknownObject: unknown): unknownObject is RawTelemetryReporter {
  return !!(unknownObject as RawTelemetryReporter).report;
}

export interface RawTelemetryReporter {
  flush: EventEmitter<void>;
  report(entityName: string, entityProperties: TelemetryEntityProperties);
}

export class NullRawTelemetryReporter implements RawTelemetryReporter {
  public readonly flush = new EventEmitter<void>();
  report(entityName: string, entityProperties: object) {}
}

export class RawTelemetryReporterToDap implements RawTelemetryReporter {
  public readonly flush = new EventEmitter<void>();

  public constructor(private readonly _dap: Dap.Api) { }

  report(entityName: string, entityProperties: TelemetryEntityProperties) {
    this._dap.output({
      category: 'telemetry',
      output: entityName,
      data: JSON.stringify(entityProperties)
    });
  };
}

// Pattern: The pattern recognizes file paths and captures the file name and the colon at the end.
// Next line is a sample path aligned with the regexp parts that recognize it/match it. () is for the capture group
//                                C  :     \  foo      \  (in.js:)
//                                C  :     \  foo\ble  \  (fi.ts:)
const extractFileNamePattern = /[A-z]:(?:[\\/][^:]*)+[\\/]([^:]*:)/g;


interface ErrorTelemetryProperties {
  message: string | undefined;
  name: string | undefined;
  stack: string | undefined;
}

function extractErrorDetails(e: any): { error: ErrorTelemetryProperties } {
  const message = ("" + e.message) || e.toString();
  const name = "" + e.name;

  const stack = typeof e.stack === 'string'
    ? e.stack.replace(extractFileNamePattern, '$1')
    : undefined;

  return { error: { message, name, stack } };
}
