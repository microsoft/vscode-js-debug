/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { getSyntaxErrorIn } from '../../../common/sourceUtils';
import { Dap } from '../../../dap/api';
import { invalidBreakPointCondition } from '../../../dap/errors';
import { ProtocolError } from '../../../dap/protocolError';
import { IBreakpointCondition } from '.';

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
