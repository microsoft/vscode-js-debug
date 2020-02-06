/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Dap from '../../../dap/api';
import { ILogger } from '../../../common/logging';
import { LogPointCompiler } from './logPoint';
import { SimpleCondition } from './simple';
import { HitCondition } from './hitCount';

/**
 * A condition provided to the {@link UserDefinedBreakpoint}
 */
export interface IBreakpointCondition {
  /**
   * Expression to evaluate that returns whether Chrome should paused on the
   * breakpoint.
   */
  readonly breakCondition: string | undefined;

  /**
   * Called when Chrome pauses on a breakpoint returns whether the debugger
   * should stay paused there.
   */
  shouldStayPaused(): boolean;
}

/**
 * Condition that indicates we should always break at the give spot.
 */
export const AlwaysBreak = new SimpleCondition(undefined);

export class BreakpointConditionFactory {
  private logPointCompiler: LogPointCompiler;

  constructor(logger: ILogger) {
    this.logPointCompiler = new LogPointCompiler(logger);
  }

  public getConditionFor(params: Dap.SourceBreakpoint): IBreakpointCondition {
    if (params.condition) {
      return new SimpleCondition(params.condition);
    }

    if (params.logMessage) {
      return this.logPointCompiler.compile(params.logMessage);
    }

    if (params.hitCondition) {
      return HitCondition.parse(params.hitCondition);
    }

    return AlwaysBreak;
  }
}
