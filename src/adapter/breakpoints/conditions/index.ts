/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import Cdp from '../../../cdp/api';
import { AnyLaunchConfiguration } from '../../../configuration';
import Dap from '../../../dap/api';
import { IEvaluator } from '../../evaluator';
import { ExpressionCondition } from './expression';
import { HitCondition } from './hitCount';
import { LogPointCompiler } from './logPoint';
import { SimpleCondition } from './simple';

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
 * Condition that indicates we should never break at the give spot.
 */
export const NeverBreak = new SimpleCondition({ line: 0 }, 'false');

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
  private breakOnError: boolean;

  constructor(
    @inject(LogPointCompiler) private readonly logPointCompiler: LogPointCompiler,
    @inject(IEvaluator) private readonly evaluator: IEvaluator,
    @inject(AnyLaunchConfiguration) launchConfig: AnyLaunchConfiguration,
  ) {
    this.breakOnError = launchConfig.__breakOnConditionalError;
  }

  public getConditionFor(params: Dap.SourceBreakpoint): IBreakpointCondition {
    if (params.condition) {
      return ExpressionCondition.parse(
        params,
        params.condition,
        this.breakOnError,
        this.evaluator,
      );
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
