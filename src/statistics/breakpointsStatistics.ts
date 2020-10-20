/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable } from 'inversify';
import { UserDefinedBreakpoint } from '../adapter/breakpoints/userDefinedBreakpoint';
import { Source } from '../adapter/sources';
import { SourceMapOrigin } from '../common/sourceMaps/sourceMap';
import { Dap } from '../dap/api';

class BreakpointStatistic {
  public constructor(
    public verified = false,
    public hit = false,
    public sourceMapOrigin: SourceMapOrigin | undefined = undefined,
  ) {}
}

export interface IMapOriginStatistics {
  breakpointPredictor: number;
  scriptParsed: number;
  breakpointPredictorAndScriptParsed: number;
}

export interface IManyBreakpointsStatistics {
  set: number;
  verified: number;
  hit: number;
  hitSources: IMapOriginStatistics;
  verifiedSources: IMapOriginStatistics;
  sourceMapOrigin: IMapOriginStatistics;
}

@injectable()
export class BreakpointsStatisticsCalculator {
  private readonly _breakpointStatisticsById = new Map<number, BreakpointStatistic>();
  private readonly _sourcesStatistics: IMapOriginStatistics = {
    breakpointPredictor: 0,
    breakpointPredictorAndScriptParsed: 0,
    scriptParsed: 0,
  };

  public registerBreakpoints(manyBreakpoints: Dap.Breakpoint[]): void {
    manyBreakpoints.forEach(breakpoint => {
      breakpoint.id !== undefined &&
        !this._breakpointStatisticsById.has(breakpoint.id) &&
        this._breakpointStatisticsById.set(
          breakpoint.id,
          new BreakpointStatistic(breakpoint.verified, false),
        );
    });
  }

  public recordSourceStatistics(source: Source) {
    this.accumulateSources(
      this._sourcesStatistics,
      this.calculateSourceMapStatistics(source.sourceMap?.metadata.sourceMapOrigin),
    );
  }

  public registerResolvedBreakpoint(breakpoint: UserDefinedBreakpoint) {
    const statistics = this.getStatistics(breakpoint);
    statistics.verified = true;
  }

  public registerBreakpointHit(breakpoint: UserDefinedBreakpoint) {
    const statistics = this.getStatistics(breakpoint);
    statistics.hit = true;
  }

  private getStatistics(breakpoint: UserDefinedBreakpoint): BreakpointStatistic {
    let statistic = this._breakpointStatisticsById.get(breakpoint.dapId);
    if (statistic !== undefined) {
      return statistic;
    } else {
      statistic = new BreakpointStatistic(false, false);
      this._breakpointStatisticsById.set(breakpoint.dapId, statistic);
    }

    if (!statistic.sourceMapOrigin) {
      statistic.sourceMapOrigin = breakpoint.sourceMapOrigin();
    }

    return statistic;
  }

  public statistics(): IManyBreakpointsStatistics {
    let count = 0;
    let verified = 0;
    let hit = 0;
    const hitMapOrigin: IMapOriginStatistics = {
      breakpointPredictor: 0,
      breakpointPredictorAndScriptParsed: 0,
      scriptParsed: 0,
    };
    const verifiedMapOrigin = { ...hitMapOrigin };

    for (const singleStatistic of this._breakpointStatisticsById.values()) {
      count++;
      const breakpointSources = this.calculateSourceMapStatistics(singleStatistic.sourceMapOrigin);

      if (singleStatistic.hit) {
        hit++;
        this.accumulateSources(hitMapOrigin, breakpointSources);
      }
      if (singleStatistic.verified) {
        verified++;
        this.accumulateSources(verifiedMapOrigin, breakpointSources);
      }
    }

    return {
      set: count,
      verified,
      hit,
      hitSources: hitMapOrigin,
      verifiedSources: verifiedMapOrigin,
      sourceMapOrigin: this._sourcesStatistics,
    };
  }

  private accumulateSources(accumulation: IMapOriginStatistics, singlePoint: IMapOriginStatistics) {
    accumulation.breakpointPredictorAndScriptParsed +=
      singlePoint.breakpointPredictorAndScriptParsed;
    accumulation.breakpointPredictor += singlePoint.breakpointPredictor;
    accumulation.scriptParsed += singlePoint.scriptParsed;
  }

  private calculateSourceMapStatistics(
    sourceMapOrigin: SourceMapOrigin | undefined,
  ): IMapOriginStatistics {
    if (sourceMapOrigin) {
      if (sourceMapOrigin === 'breakpointsPredictor') {
        return { breakpointPredictor: 1, breakpointPredictorAndScriptParsed: 0, scriptParsed: 0 };
      } else if (sourceMapOrigin === 'scriptParsed') {
        return { breakpointPredictor: 0, breakpointPredictorAndScriptParsed: 0, scriptParsed: 1 };
      }
    }

    return { breakpointPredictor: 0, breakpointPredictorAndScriptParsed: 0, scriptParsed: 0 };
  }
}
