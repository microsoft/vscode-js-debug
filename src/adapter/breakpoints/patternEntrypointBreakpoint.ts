/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { BreakpointManager, EntryBreakpointMode } from '../breakpoints';
import { Thread } from '../threads';
import { EntryBreakpoint } from './entryBreakpoint';
import { forceForwardSlashes } from '../../common/pathUtils';
import { makeRe } from 'micromatch';

/**
 * A breakpoint set from the `runtimeSourcemapPausePatterns`. Unlike a normal
 * entrypoint breakpoint, it's always applied from the "path" as its pattern.
 */
export class PatternEntryBreakpoint extends EntryBreakpoint {
  constructor(manager: BreakpointManager, private readonly pattern: string) {
    super(manager, { path: pattern }, EntryBreakpointMode.Greedy);
  }

  /**
   * @override
   */
  public async enable(thread: Thread): Promise<void> {
    if (this.isEnabled) {
      return;
    }

    this.isEnabled = true;
    const re = makeRe(forceForwardSlashes(this.pattern), { contains: true, lookbehinds: false });
    await this._setAny(thread, {
      // fix case sensitivity on drive letter:
      urlRegex: re.source.replace(
        /([a-z]):/i,
        (m, drive) => `[${drive.toLowerCase()}${drive.toUpperCase()}]:`,
      ),
      lineNumber: 0,
      columnNumber: 0,
    });
  }
}
