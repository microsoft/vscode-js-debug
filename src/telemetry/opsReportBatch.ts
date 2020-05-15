/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IRPCMetrics, IRPCMetricsAndErrorsMap } from './classification';

/**
 * Batches reported metrics per method call, giving performance information.
 */
export class ReporterBatcher {
  // prototype-free object so that we don't need to do hasOwnProperty checks
  private measurements: { [method: string]: { times: number[]; errors: Error[] } } = Object.create(
    null,
  );

  /**
   * Adds a new measurement for the given method.
   */
  public add(method: string, measurement: number, error?: Error) {
    let arr = this.measurements[method];
    if (!arr) {
      arr = this.measurements[method] = { times: [], errors: [] };
    }

    arr.times.push(measurement);
    if (error) {
      arr.errors.push(error);
    }
  }

  /**
   * Returns a summary of collected measurements taken
   * since the last flush() call.
   */
  public flush(): IRPCMetricsAndErrorsMap {
    const results: IRPCMetricsAndErrorsMap = { errors: [] };
    for (const key in this.measurements) {
      const { times, errors } = this.measurements[key];
      const item: IRPCMetrics = {
        operation: key,
        totalTime: 0,
        max: 0,
        avg: 0,
        stddev: 0,
        count: times.length,
        failed: errors.length,
      };

      for (const t of times) {
        item.totalTime += t;
        item.max = Math.max(item.max, t);
      }

      item.avg = item.totalTime / item.count;
      for (const t of times) {
        item.stddev += (t - item.avg) ** 2;
      }

      item.stddev = Math.sqrt(item.stddev / (times.length - 1));
      results[item.operation] = item;
      results[`!${item.operation}.errors`] = errors;
    }

    this.measurements = Object.create(null);

    return results;
  }
}
