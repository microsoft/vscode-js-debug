/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import { ILogger, LogTag } from '../common/logging';
import { isInstanceOf } from '../common/objUtils';
import { AnyLaunchConfiguration } from '../configuration';
import { ExpectedPauseReason, IPausedDetails, PausedReason, StepDirection } from './pause';
import { isSourceWithMap } from './source';
import { UnmappedReason } from './sourceContainer';
import { StackFrame } from './stackTrace';

export const enum StackFrameStepOverReason {
  NotStepped,
  SmartStep,
  Blackboxed,
}

export async function shouldStepOverStackFrame(
  stackFrame: StackFrame,
): Promise<StackFrameStepOverReason> {
  const uiLocation = await stackFrame.uiLocation();
  if (!uiLocation) {
    return StackFrameStepOverReason.NotStepped;
  }

  if (uiLocation.source.blackboxed()) {
    return StackFrameStepOverReason.Blackboxed;
  }

  if (!isSourceWithMap(uiLocation.source)) {
    return StackFrameStepOverReason.NotStepped;
  }

  if (!uiLocation.isMapped && uiLocation.unmappedReason === UnmappedReason.MapPositionMissing) {
    return StackFrameStepOverReason.SmartStep;
  }

  return StackFrameStepOverReason.NotStepped;
}

const neverStepReasons: ReadonlySet<PausedReason> = new Set(['breakpoint', 'exception', 'entry']);

const smartStepBackoutThreshold = 256;

/**
 * The SmartStepper is a device that controls stepping through code that lacks
 * sourcemaps when running in an application with source maps.
 */
@injectable()
export class SmartStepper {
  private _smartStepCount = 0;

  constructor(
    @inject(AnyLaunchConfiguration) private readonly launchConfig: AnyLaunchConfiguration,
    @inject(ILogger) private readonly logger: ILogger,
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

    const frame = (await pausedDetails.stackTrace.loadFrames(1)).find(isInstanceOf(StackFrame));
    const should = frame && (await shouldStepOverStackFrame(frame));
    if (should === StackFrameStepOverReason.NotStepped) {
      this.resetSmartStepCount();
      return;
    }

    if (this._smartStepCount++ > smartStepBackoutThreshold) {
      return StepDirection.Out;
    }

    return reason?.reason === 'step' ? reason.direction : StepDirection.In;
  }
}
