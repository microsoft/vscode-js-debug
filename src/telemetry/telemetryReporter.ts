// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Dap from '../dap/api';
import { HighResolutionTime, calculateElapsedTime } from '../utils/performance';
import { OpsReportBatcher, UnbatchedOpReport, TelemetryOperationProperties } from './opsReportBatch';
import { EventEmitter } from '../common/events';

export type TelemetryEntityProperties = object;
export type OutcomeAndTime = { time: number, succesful: boolean };

enum RequestOutcome {
  Succesful,
  Failed
}

export interface TelemetryReporterStrategy {
  eventsPrefix: string;
  adjustElapsedTime(elapsedTime: number): number;
  report(eventName: string, entityProperties: TelemetryEntityProperties): void;
}

export class TelemetryReporter {
  private constructor(private readonly _strategy: TelemetryReporterStrategy) {}

  public static dap(dap: Dap.Api): TelemetryReporter {
    return new TelemetryReporter(new DapRequestTelemetryReporter(dap));
  }
  public static cdp(rawTelemetryReporter: RawTelemetryReporter): TelemetryReporter {
    return new TelemetryReporter(new CdpTelemetryReporter(rawTelemetryReporter));
  }

  reportError(dapCommand: string, receivedTime: HighResolutionTime, error: unknown) {
    this.reportOutcome(receivedTime, dapCommand, extractErrorDetails(error), RequestOutcome.Failed);
  }

  reportSuccess(dapCommand: string, receivedTime: HighResolutionTime) {
    this.reportOutcome(receivedTime, dapCommand, {}, RequestOutcome.Succesful);
  }

  reportEvent(event: string, data?: any) {
    this._strategy.report(`${this._strategy.eventsPrefix}/${event}`, data);
  }

  private reportOutcome(receivedTime: [number, number], dapCommand: string, properties: TelemetryEntityProperties, outcome: RequestOutcome) {
    const elapsedTime = calculateElapsedTime(receivedTime);
    const entityProperties = { ...properties, time: this._strategy.adjustElapsedTime(elapsedTime), succesful: outcome === RequestOutcome.Succesful };
    this._strategy.report(`${this._strategy.eventsPrefix}/` + dapCommand, entityProperties);
  }
}

class DapRequestTelemetryReporter {
  private readonly _rawTelemetryReporter: RawTelemetryReporterToDap;

  public readonly eventsPrefix = 'dap';
  public readonly adjustElapsedTime = (x: number) => x;

  public constructor(dap: Dap.Api) {
    this._rawTelemetryReporter = new RawTelemetryReporterToDap(dap);
  }

  public report(eventName: string, entityProperties: TelemetryEntityProperties): void {
    this._rawTelemetryReporter.report(eventName, entityProperties);
  }
}

class CdpTelemetryReporter {
  private readonly _batcher = new OpsReportBatcher();

  public constructor(private readonly _rawTelemetryReporter: RawTelemetryReporter) {
    this._rawTelemetryReporter.flush.event(() => {
      this._rawTelemetryReporter.report('cdpOperations', this._batcher.batched());
    });
  }

  // Floating point numbers use too much space and we don't need that much precision, we use integers to use less space when batching timings
  public readonly adjustElapsedTime = Math.ceil;

  public readonly eventsPrefix = 'cdp';

  public report(eventName: string, entityProperties: TelemetryOperationProperties) {
    // CDP generates a lot of operations, so instead of reporting them one by one, we batch them all together
    this._batcher.add(new UnbatchedOpReport(eventName, entityProperties));
  }
}

export interface RawTelemetryReporter {
  flush: EventEmitter<void>;
  report(entityName: string, entityProperties: TelemetryEntityProperties): void;
}

export class RawTelemetryReporterToDap implements RawTelemetryReporter {
  public readonly flush = new EventEmitter<void>();

  public constructor(private readonly _dap: Dap.Api) { }

  report(entityName: string, entityProperties: TelemetryEntityProperties) {
    this._dap.output({
      category: 'telemetry',
      output: entityName,
      data: entityProperties
    });
  };
}

// Pattern: The pattern recognizes file paths and captures the file name and the colon at the end.
// Next line is a sample path aligned with the regexp parts that recognize it/match it. () is for the capture group
//                                C  :     \  foo      \  (in.js:)
//                                C  :     \  foo\ble  \  (fi.ts:)
const extractFileNamePattern = /(?:[A-z]:)?(?:[\\/][^:]*)+[\\/]([^:]*:)/g;


interface ErrorTelemetryProperties {
  message: string | undefined;
  name: string | undefined;
  stack: string | undefined;
}

export function extractErrorDetails(e: any): { error: ErrorTelemetryProperties } {
  const message = ("" + e.message) || e.toString();
  const name = "" + e.name;

  const stack = typeof e.stack === 'string'
    ? e.stack.replace(extractFileNamePattern, '$1')
    : undefined;

  return { error: { message, name, stack } };
}
