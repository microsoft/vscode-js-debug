/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Dap from '../../../dap/api';
import { LogPointCompiler } from './logPoint';
import { SimpleCondition } from './simple';
import { HitCondition } from './hitCount';
import Cdp from '../../../cdp/api';
import { injectable, inject } from 'inversify';

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
  shouldStayPaused(details: Cdp.Debugger.PausedEvent): Promise<boolean>;
}

/**
 * Condition that indicates we should always break at the give spot.
 */
export const AlwaysBreak = new SimpleCondition({ line: 0 }, undefined);

/**
 * Creates breakpoint conditions for source breakpoints.
 */
export interface IBreakpointConditionFactory {
  /**
   * Gets a condition for the given breakpoint.
   */
  getConditionFor(params: Dap.SourceBreakpoint): IBreakpointCondition;
}

export const IBreakpointConditionFactory = Symbol('IBreakpointConditionFactory');

@injectable()
export class BreakpointConditionFactory implements IBreakpointConditionFactory {
  constructor(@inject(LogPointCompiler) private readonly logPointCompiler: LogPointCompiler) {}

  public getConditionFor(params: Dap.SourceBreakpoint): IBreakpointCondition {
    if (params.condition) {
      return new SimpleCondition(params, params.condition);
    }

    if (params.logMessage) {
      return this.logPointCompiler.compile(params, params.logMessage);
    }

    if (params.hitCondition) {
      return HitCondition.parse(params.hitCondition);
    }

    return AlwaysBreak;
  }
}
