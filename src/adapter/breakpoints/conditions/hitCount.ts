/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ProtocolError, invalidHitCondition } from '../../../dap/errors';
import { IBreakpointCondition } from '.';

/**
 * Regex used to match hit conditions. It matches the operator in group 1 and
 * the constant in group 2.
 */
const hitConditionRe = /^(>|>=|={1,3}|<|<=|%)?\s*([0-9]+)$/;

/**
 * A hit condition breakpoint encapsulates the handling of breakpoints hit on
 * a certain "nth" times we pause on them. For instance, a user could define
 * a hit condition breakpoint to pause the second time we reach it.
 *
 * This is used and exposed by the {@link Breakpoint} class.
 */
export class HitCondition implements IBreakpointCondition {
  private hits = 0;
  public readonly breakCondition = undefined;

  constructor(private readonly predicate: (n: number) => boolean) {}

  /**
   * @inheritdoc
   */
  public shouldStayPaused() {
    return Promise.resolve(this.predicate(++this.hits));
  }

  /**
   * Parses the hit condition expression, like "> 42", into a {@link HitCondition}.
   * @throws {ProtocolError} if the expression is invalid
   */
  public static parse(expression: string): IBreakpointCondition {
    const parts = hitConditionRe.exec(expression);
    if (!parts) {
      throw new ProtocolError(invalidHitCondition(expression));
    }

    const [, op, value] = parts;
    const expr =
      op === '%'
        ? `return (numHits % ${value}) === 0;`
        : op[0] === '='
        ? `return numHits === ${value};`
        : `return numHits ${op} ${value};`;

    return new HitCondition(new Function('numHits', expr) as (n: number) => boolean);
  }
}
