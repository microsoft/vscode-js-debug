/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IBreakpointCondition } from '.';
import { PreparedCallFrameExpr } from '../../evaluator';
import Cdp from '../../../cdp/api';

/**
 * A logpoint that requires being paused and running a custom expression to
 * log correctly.
 */
export class RuntimeLogPoint implements IBreakpointCondition {
  public readonly breakCondition = undefined;

  constructor(private readonly invoke: PreparedCallFrameExpr) {}

  public async shouldStayPaused(details: Cdp.Debugger.PausedEvent) {
    await this.invoke({ callFrameId: details.callFrames[0].callFrameId });
    return false;
  }
}
