/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Cdp from '../../../cdp/api';
import { getSyntaxErrorIn } from '../../../common/sourceUtils';
import { Dap } from '../../../dap/api';
import { invalidBreakPointCondition } from '../../../dap/errors';
import { ProtocolError } from '../../../dap/protocolError';
import { IEvaluator, PreparedCallFrameExpr } from '../../evaluator';
import { IBreakpointCondition } from '.';

/**
 * Conditional breakpoint using a user-defined expression.
 */
export class ExpressionCondition implements IBreakpointCondition {
  public static parse(
    params: Dap.SourceBreakpoint,
    breakCondition: string,
    breakOnError: boolean,
    evaluator: IEvaluator,
  ) {
    breakCondition = wrapBreakCondition(breakCondition, breakOnError);

    const err = breakCondition && getSyntaxErrorIn(breakCondition);
    if (err) {
      throw new ProtocolError(invalidBreakPointCondition(params, err.message));
    }

    const { canEvaluateDirectly, invoke } = evaluator.prepare(breakCondition);
    return new ExpressionCondition(canEvaluateDirectly ? breakCondition : invoke);
  }

  private readonly invoke?: PreparedCallFrameExpr;

  /** @inheritdoc */
  public readonly breakCondition: string | undefined;

  constructor(breakCondition: string | PreparedCallFrameExpr) {
    if (typeof breakCondition === 'function') {
      this.invoke = breakCondition;
    } else {
      this.breakCondition = breakCondition;
    }
  }

  /** @inheritdoc */
  public async shouldStayPaused(details: Cdp.Debugger.PausedEvent) {
    if (!this.invoke) {
      return Promise.resolve(true);
    }

    const evaluated = await this.invoke({
      callFrameId: details.callFrames[0].callFrameId,
      returnByValue: true,
    });

    return evaluated?.result.value === true;
  }
}

export const wrapBreakCondition = (condition: string, breakOnError: boolean) =>
  `(()=>{try{return ${condition};}catch(e){console.error(\`Breakpoint condition error: \${e.message||e}\`);return ${!!breakOnError}}})()`;
