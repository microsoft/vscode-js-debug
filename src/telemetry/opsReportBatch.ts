// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { OutcomeAndTime, TelemetryEntityProperties } from './telemetryReporter';
import * as _ from 'lodash';

/* Sample telemetry:
 *
{
  "cdp/Target.attachedToTarget": {
    "succesful": {
      "totalTime": 7,
      "maxTime": 4,
      "avgTime": 2.3333333333333335,
      "count": 3,
      "breakdown": {
        "time": "[1,2,4]",
        <more properties might appear here in the future>
      }
    },
    <if there are failures, we'll have a failed: section here>
  },
"cdp/Debugger.scriptParsed": {
    "succesful": {
      "totalTime": 8,
      "maxTime": 5,
      "avgTime": 4,
      "count": 2,
      "breakdown": {
        "time": "[5,3]"
      }
    }
  },
  <etc...>
 }
}
 */

export class OpsReportBatcher {
  private reports: UnbatchedOpReport[] = [];

  public add(report: UnbatchedOpReport) {
    this.reports.push(report);
  }

  public batched(): OpsReportBatch {
    const opsGroupedByName = _.groupBy(this.reports, report => report.operationName);
    const propertiesGroupedByName = _.mapValues(opsGroupedByName, manyOpsReports => manyOpsReports.map(operation => operation.properties));
    const opsByNameReport = _.mapValues(propertiesGroupedByName, propertiesSharingOpName => this.batchOpsSharingName(propertiesSharingOpName));
    this.reports = [];
    return opsByNameReport;
  }

  public batchOpsSharingName(opsReports: TelemetryOperationProperties[]): OpsSharingNameReportBatch {
    const opsGroupedByOutcome = _.groupBy(opsReports, report => report.succesful);
    const succesfulOps = opsGroupedByOutcome['true'] ? this.batchOpsSharingNameAndOutcome(opsGroupedByOutcome['true'] || []) : undefined;
    const failedOps = opsGroupedByOutcome['false'] ? this.batchOpsSharingNameAndOutcome(opsGroupedByOutcome['false'] || []) : undefined;
    return new OpsSharingNameReportBatch(succesfulOps, failedOps);
  }

  public batchOpsSharingNameAndOutcome(opsReports: TelemetryOperationProperties[]): OpsSharingNameAndOutcomeReportBatch {
    const count = opsReports.length;
    const totalTime = opsReports.reduce((reduced, next) => reduced + next.time, 0);
    const maxTime = opsReports.reduce((reduced, next) => Math.max(reduced, next.time), -Infinity);
    const avgTime = totalTime / count;

    const aggregated = aggregateIntoSingleObject(opsReports);
    delete aggregated.succesful; // We are groupping by success vs failure on a higher level, so we don't need to store this information again

    const aggregatedWithStringProperties = _.mapValues(aggregated, JSON.stringify);

    return new OpsSharingNameAndOutcomeReportBatch(totalTime, maxTime, avgTime, count, aggregatedWithStringProperties);
  }
}

function extractAllPropertyNames(objects: object[]): string[] {
  return _.uniq(_.flatten(objects.map(object => Object.keys(object))));
}

function aggregateIntoSingleObject(objectsToAggregate: object[]): { [propertyName: string]: unknown[] } {
  const manyPropertyNames = extractAllPropertyNames(objectsToAggregate);
  const aggregatedObject = <{ [propertyName: string]: unknown[] }> <unknown>
    _.fromPairs(manyPropertyNames.map((propertyName: string) => {
      return [propertyName, objectsToAggregate.map((objectToAggregate: object) => objectToAggregate[propertyName])];
    }));

  return aggregatedObject;
}

export class UnbatchedOpReport {
  public constructor(public readonly operationName: string, public readonly properties: TelemetryOperationProperties) { }
}

export interface OpsReportBatch {
  [operationName: string]: OpsSharingNameReportBatch;
}

export class OpsSharingNameReportBatch {
  public constructor(public readonly succesful: OpsSharingNameAndOutcomeReportBatch | undefined, public readonly failed: OpsSharingNameAndOutcomeReportBatch | undefined) { }
}

export class OpsSharingNameAndOutcomeReportBatch {
  public constructor(
    public readonly totalTime: number,
    public readonly maxTime: number,
    public readonly avgTime: number,
    public readonly count: number,
    public readonly breakdown: unknown
  ) { }
}

export type TelemetryOperationProperties = OutcomeAndTime & TelemetryEntityProperties;
