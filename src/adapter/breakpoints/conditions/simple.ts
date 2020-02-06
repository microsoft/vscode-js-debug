/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IBreakpointCondition } from '.';

/**
 * Simple conditional breakpoint with an expression evaluated on the browser
 * side of things.
 */
export class SimpleCondition implements IBreakpointCondition {
  constructor(public readonly breakCondition: string | undefined) {}

  public shouldStayPaused() {
    return true; // if Chrome paused on us, it means the expression passed
  }
}
