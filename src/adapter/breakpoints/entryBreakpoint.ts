/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Breakpoint } from './breakpointBase';
import { BreakpointManager } from '../breakpoints';
import Dap from '../../dap/api';

/**
 * A breakpoint set automatically on module entry.
 */
export class EntryBreakpoint extends Breakpoint {
  constructor(manager: BreakpointManager, source: Dap.Source) {
    super(manager, source, { lineNumber: 1, columnNumber: 1 });
  }
}
