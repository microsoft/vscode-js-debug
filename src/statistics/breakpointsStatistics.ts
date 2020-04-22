/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Dap } from '../dap/api';

class BreakpointStatistic {
  public constructor(public verified = false, public hit = false) {}
}

export interface IManyBreakpointsStatistics {
  set: number;
  verified: number;
  hit: number;
}

export class BreakpointsStatisticsCalculator {
  private readonly _statisticsById = new Map<number, BreakpointStatistic>();

  public registerBreakpoints(manyBreakpoints: Dap.Breakpoint[]): void {
    manyBreakpoints.forEach(breakpoint => {
      breakpoint.id !== undefined &&
        !this._statisticsById.has(breakpoint.id) &&
        this._statisticsById.set(
          breakpoint.id,
          new BreakpointStatistic(breakpoint.verified, false),
        );
    });
  }

  public registerResolvedBreakpoint(breakpointId: number) {
    this.getStatistics(breakpointId).verified = true;
  }

  public registerBreakpointHit(breakpointId: number) {
    this.getStatistics(breakpointId).hit = true;
  }

  private getStatistics(breakpointId: number): BreakpointStatistic {
    const statistic = this._statisticsById.get(breakpointId);
    if (statistic !== undefined) {
      return statistic;
    } else {
      const newStatistic = new BreakpointStatistic();
      this._statisticsById.set(breakpointId, newStatistic);
      return newStatistic;
    }
  }

  public statistics(): IManyBreakpointsStatistics {
    let count = 0;
    let verified = 0;
    let hit = 0;
    for (const singleStatistic of this._statisticsById.values()) {
      count++;
      if (singleStatistic.hit) hit++;
      if (singleStatistic.verified) verified++;
    }

    return { set: count, verified, hit };
  }
}
