/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { CdpReferenceState, Breakpoint, BreakpointCdpReference } from './breakpointBase';
import * as nls from 'vscode-nls';
import { BreakpointManager, kLogPointUrl } from '../breakpoints';
import Dap from '../../dap/api';
import { rewriteLogPoint } from '../../common/sourceUtils';
import { getDeferred } from '../../common/promiseUtil';
import { HitCondition } from './hitCondition';
import { Thread } from '../threads';
import Cdp from '../../cdp/api';

const localize = nls.loadMessageBundle();

export class UserDefinedBreakpoint extends Breakpoint {
  /**
   * A deferred that resolves once the breakpoint 'set' response has been
   * returned to the UI. We should wait for this to finish before sending any
   * notifications about breakpoint changes.
   */
  private readonly completedSet = getDeferred<void>();

  /**
   * @param hitCondition - Hit condition for this breakpoint. See
   * {@link HitCondition} for more information.
   */
  constructor(
    manager: BreakpointManager,
    public readonly dapId: number,
    source: Dap.Source,
    private readonly dapParams: Dap.SourceBreakpoint,
    private readonly hitCondition?: HitCondition,
  ) {
    super(manager, source, { lineNumber: dapParams.line, columnNumber: dapParams.column || 1 });
  }

  /**
   * Returns a promise that resolves once the breakpoint 'set' response
   */
  public untilSetCompleted() {
    return this.completedSet.promise;
  }

  /**
   * Marks the breakpoint 'set' as having finished.
   */
  public markSetCompleted() {
    this.completedSet.resolve();
  }

  /**
   * Returns whether the debugger should remain paused on this breakpoint
   * according to the hit condition.
   */
  public testHitCondition() {
    return this.hitCondition?.test() ?? true;
  }

  /**
   * Returns a DAP representation of the breakpoint. If the breakpoint is
   * resolved, this will be fulfilled with the complete source location.
   */
  public async toDap(): Promise<Dap.Breakpoint> {
    const location = this.getResolvedUiLocation();
    if (location) {
      return {
        id: this.dapId,
        verified: true,
        source: await location.source.toDap(),
        line: location.lineNumber,
        column: location.columnNumber,
      };
    }

    return {
      id: this.dapId,
      verified: false,
      message: localize('breakpoint.provisionalBreakpoint', `Unbound breakpoint`), // TODO: Put a useful message here
    };
  }

  /**
   * @inheritdoc
   */
  public async updateUiLocations(
    thread: Thread,
    cdpId: Cdp.Debugger.BreakpointId,
    resolvedLocations: Cdp.Debugger.Location[],
  ) {
    const hadPreviousLocation = !!this.getResolvedUiLocation();
    await super.updateUiLocations(thread, cdpId, resolvedLocations);
    if (!hadPreviousLocation) {
      this.notifyResolved();
    }
  }

  /**
   * @override
   */
  protected getBreakCondition() {
    const { logMessage, condition } = this.dapParams;

    const expressions: string[] = [];
    if (logMessage) {
      expressions.push(rewriteLogPoint(logMessage) + `\n//# sourceURL=${kLogPointUrl}`);
    }

    if (condition) {
      expressions.push(condition);
    }

    return expressions.length ? expressions.join(' && ') : undefined;
  }

  /**
   * @override
   */
  protected updateCdpRefs(
    mutator: (l: ReadonlyArray<BreakpointCdpReference>) => ReadonlyArray<BreakpointCdpReference>,
  ) {
    const previousLocation = this.getResolvedUiLocation();
    super.updateCdpRefs(mutator);

    if (this.getResolvedUiLocation() !== previousLocation) {
      this.notifyResolved();
    }
  }

  /**
   * Gets the location whether this breakpoint is resolved, if any.
   */
  private getResolvedUiLocation() {
    for (const bp of this.cdpBreakpoints) {
      if (bp.state === CdpReferenceState.Applied && bp.uiLocations.length) {
        return bp.uiLocations[0];
      }
    }

    return undefined;
  }

  /**
   * Called the breakpoint manager to notify that the breakpoint is resolved,
   * used for statistics and notifying the UI.
   */
  private async notifyResolved(): Promise<void> {
    const location = this.getResolvedUiLocation();
    if (location) {
      await this._manager.notifyBreakpointResolved(
        this.dapId,
        location,
        this.completedSet.hasSettled(),
      );
    }
  }
}
