/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { basename, extname } from 'path';
import { escapeRegexSpecialChars } from '../../common/stringUtils';
import Dap from '../../dap/api';
import { BreakpointManager, EntryBreakpointMode } from '../breakpoints';
import { Thread } from '../threads';
import { Breakpoint, LineColumn } from './breakpointBase';

/**
 * A breakpoint set automatically on module entry.
 */
export class EntryBreakpoint extends Breakpoint {
  public static getModeKeyForSource(mode: EntryBreakpointMode, path: string) {
    return mode === EntryBreakpointMode.Greedy
      ? basename(path, extname(path) || undefined)
      : path;
  }

  constructor(
    manager: BreakpointManager,
    source: Dap.Source,
    private readonly mode: EntryBreakpointMode,
  ) {
    super(manager, source, { lineNumber: 1, columnNumber: 1 });
  }

  protected _setPredicted() {
    return Promise.resolve();
  }

  protected _setByPath(thread: Thread, lineColumn: LineColumn) {
    if (!this.source.path) {
      return Promise.resolve();
    }

    const key = EntryBreakpoint.getModeKeyForSource(this.mode, this.source.path);
    return this.mode === EntryBreakpointMode.Greedy
      ? super._setByUrlRegexp(thread, escapeRegexSpecialChars(key), lineColumn)
      : super._setByPath(thread, lineColumn);
  }
}
