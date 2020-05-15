/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IBreakpointCondition } from '.';
import { getSyntaxErrorIn } from '../../../common/sourceUtils';
import { ProtocolError, invalidBreakPointCondition } from '../../../dap/errors';
import { Dap } from '../../../dap/api';

/**
 * Simple conditional breakpoint with an expression evaluated on the browser
 * side of things.
 */
export class SimpleCondition implements IBreakpointCondition {
  constructor(params: Dap.SourceBreakpoint, public readonly breakCondition: string | undefined) {
    const err = breakCondition && getSyntaxErrorIn(breakCondition);
    if (err) {
      throw new ProtocolError(invalidBreakPointCondition(params, err.message));
    }
  }

  public shouldStayPaused() {
    return Promise.resolve(true); // if Chrome paused on us, it means the expression passed
  }
}
