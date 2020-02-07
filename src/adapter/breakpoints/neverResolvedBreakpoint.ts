/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { BreakpointManager } from '../breakpoints';
import { UserDefinedBreakpoint } from './userDefinedBreakpoint';
import { HitCondition } from './conditions/hitCount';
import Dap from '../../dap/api';

/**
 * A breakpoint that's never resolved or hit. This is used to place an invalid
 * condition or hit count breakpoint; DAP does not have a representation for
 * a single breakpoint failing to set, so on a failure we show an error as
 * standard out and place one of these virtual breakpoints.
 *
 * In CDP they do end up being 'real' breakpoints so the aren't the most
 * efficient construct, but they do the job without additional work or special
 * casing.
 */
export class NeverResolvedBreakpoint extends UserDefinedBreakpoint {
  constructor(
    manager: BreakpointManager,
    dapId: number,
    source: Dap.Source,
    dapParams: Dap.SourceBreakpoint,
  ) {
    super(manager, dapId, source, dapParams, new HitCondition(() => false));
  }

  /**
   * @override
   */
  protected getResolvedUiLocation() {
    return undefined;
  }
}
