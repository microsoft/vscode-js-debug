/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ILogger, LogTag } from '../common/logging';
import { AnyLaunchConfiguration } from '../configuration';
import { isSourceWithMap, UnmappedReason } from './sources';
import { StackFrame } from './stackTrace';
import { ExpectedPauseReason, IPausedDetails, PausedReason, StepDirection } from './threads';

export async function shouldSmartStepStackFrame(stackFrame: StackFrame): Promise<boolean> {
  const uiLocation = await stackFrame.uiLocation();
  if (!uiLocation) {
    return false;
  }

  if (!isSourceWithMap(uiLocation.source)) {
    return false;
  }

  if (!uiLocation.isMapped && uiLocation.unmappedReason === UnmappedReason.MapPositionMissing) {
    return true;
  }

  return false;
}

const neverStepReasons: ReadonlySet<PausedReason> = new Set(['breakpoint', 'exception']);

/**
 * The SmartStepper is a device that controls stepping through code that lacks
 * sourcemaps when running in an application with source maps.
 */
export class SmartStepper {
  private _smartStepCount = 0;

  constructor(
    private readonly launchConfig: AnyLaunchConfiguration,
    private readonly logger: ILogger,
  ) {}

  private resetSmartStepCount(): void {
    if (this._smartStepCount > 0) {
      this.logger.verbose(LogTag.Internal, `smartStep: skipped ${this._smartStepCount} steps`);
      this._smartStepCount = 0;
    }
  }

  /**
   * Determines whether smart stepping should be run for the given pause
   * information. If so, returns the direction of stepping.
   */
  public async getSmartStepDirection(
    pausedDetails: IPausedDetails,
    reason?: ExpectedPauseReason,
  ): Promise<StepDirection | undefined> {
    if (!this.launchConfig.smartStep) {
      return;
    }

    if (neverStepReasons.has(pausedDetails.reason)) {
      return;
    }

    const frame = (await pausedDetails.stackTrace.loadFrames(1))[0];
    const should = await shouldSmartStepStackFrame(frame);
    if (!should) {
      this.resetSmartStepCount();
      return;
    }

    this._smartStepCount++;
    return reason?.reason === 'step' ? reason.direction : StepDirection.In;
  }
}
