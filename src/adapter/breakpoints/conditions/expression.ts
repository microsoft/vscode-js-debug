/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IBreakpointCondition } from '.';
import { Dap } from '../../../dap/api';
import { SimpleCondition } from './simple';

/**
 * Conditional breakpoint using a user-defined expression.
 */
export class ExpressionCondition extends SimpleCondition implements IBreakpointCondition {
  constructor(params: Dap.SourceBreakpoint, breakCondition: string, breakOnError: boolean) {
    super(params, breakOnError ? wrapBreakCondition(breakCondition) : breakCondition);
  }
}

const wrapBreakCondition = (condition: string) =>
  `(()=>{try{return ${condition};}catch(e){console.error(e);return true}})()`;
