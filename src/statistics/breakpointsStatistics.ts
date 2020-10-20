/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable } from 'inversify';
import { UserDefinedBreakpoint } from '../adapter/breakpoints/userDefinedBreakpoint';
import { Dap } from '../dap/api';

class BreakpointStatistic {
  public constructor(
    public verified = false,
    public hit = false,
    public sourceMapUrl: string | undefined = undefined,
  ) {}
}

export interface IBreakpointSources {
  breakpointPredictor: number;
  scriptParsed: number;
  breakpointPredictorAndScriptParsed: number;
}

export interface IManyBreakpointsStatistics {
  set: number;
  verified: number;
  hit: number;
  hitSources: IBreakpointSources;
  verifiedSources: IBreakpointSources;
  loadedSourcesMaps: IBreakpointSources;
}

interface ISourceMapStatistics {
  foundByBreakpointPredictor: boolean;
  loadedFromScriptParsed: boolean;
}

@injectable()
export class BreakpointsStatisticsCalculator {
  private readonly _statisticsById = new Map<number, BreakpointStatistic>();
  private readonly _sourceMapsUsedBySources = new Set<string>();
  private readonly _sourceMapStatisticsByUrl = new Map<string, ISourceMapStatistics>();

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

  registerLoadSourceUsingMap(sourceMapUrl: string) {
    this._sourceMapsUsedBySources.add(sourceMapUrl);
  }

  public registerResolvedBreakpoint(breakpoint: UserDefinedBreakpoint) {
    const statistics = this.getStatistics(breakpoint.dapId);
    statistics.verified = true;
    statistics.sourceMapUrl = breakpoint.sourceMap()?.url;
  }

  public registerBreakpointHit(breakpoint: UserDefinedBreakpoint) {
    const statistics = this.getStatistics(breakpoint.dapId);
    statistics.hit = true;
    statistics.sourceMapUrl = breakpoint.sourceMap()?.url;
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
    const hitSources: IBreakpointSources = {
      breakpointPredictor: 0,
      breakpointPredictorAndScriptParsed: 0,
      scriptParsed: 0,
    };
    const verifiedSources = { ...hitSources };
    const loadedSourcesMaps = { ...hitSources };

    for (const singleStatistic of this._statisticsById.values()) {
      count++;
      const breakpointSources = this.calculateSourceMapStatistics(
        singleStatistic.sourceMapUrl || '',
      );

      if (singleStatistic.hit) {
        hit++;
        this.accumulateSources(hitSources, breakpointSources);
      }
      if (singleStatistic.verified) {
        verified++;
        this.accumulateSources(verifiedSources, breakpointSources);
      }
    }

    for (const sourceMapUrl of this._sourceMapsUsedBySources.values()) {
      this.accumulateSources(loadedSourcesMaps, this.calculateSourceMapStatistics(sourceMapUrl));
    }

    return { set: count, verified, hit, hitSources, verifiedSources, loadedSourcesMaps };
  }

  private accumulateSources(accumulation: IBreakpointSources, singlePoint: IBreakpointSources) {
    accumulation.breakpointPredictorAndScriptParsed +=
      singlePoint.breakpointPredictorAndScriptParsed;
    accumulation.breakpointPredictor += singlePoint.breakpointPredictor;
    accumulation.scriptParsed += singlePoint.scriptParsed;
  }

  private calculateSourceMapStatistics(sourceMapUrl: string): IBreakpointSources {
    const sourceMapStatistics = this._sourceMapStatisticsByUrl.get(sourceMapUrl);
    if (sourceMapStatistics) {
      if (
        sourceMapStatistics.foundByBreakpointPredictor &&
        sourceMapStatistics.loadedFromScriptParsed
      ) {
        return { breakpointPredictor: 0, breakpointPredictorAndScriptParsed: 1, scriptParsed: 0 };
      } else if (sourceMapStatistics.foundByBreakpointPredictor) {
        return { breakpointPredictor: 1, breakpointPredictorAndScriptParsed: 0, scriptParsed: 0 };
      } else if (sourceMapStatistics.loadedFromScriptParsed) {
        return { breakpointPredictor: 0, breakpointPredictorAndScriptParsed: 0, scriptParsed: 1 };
      }
    }
    return { breakpointPredictor: 0, breakpointPredictorAndScriptParsed: 0, scriptParsed: 0 };
  }

  public registerSourceMap(sourceMapUrl: string, foundByBreakpointsPredictor: boolean) {
    const statistics = this._sourceMapStatisticsByUrl.get(sourceMapUrl) || {
      foundByBreakpointPredictor: false,
      loadedFromScriptParsed: false,
    };

    if (foundByBreakpointsPredictor) {
      statistics.foundByBreakpointPredictor = true;
    } else {
      statistics.loadedFromScriptParsed = true;
    }

    this._sourceMapStatisticsByUrl.set(sourceMapUrl, statistics);
  }
}
