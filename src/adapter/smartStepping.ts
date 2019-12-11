/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { StackFrame } from './stackTrace';
import { IPausedDetails } from './threads';
import { logger } from '../common/logging/logger';
import { LogTag } from '../common/logging';
import { AnyLaunchConfiguration } from '../configuration';
import { UnmappedReason } from './sources';

export async function shouldSmartStepStackFrame(stackFrame: StackFrame): Promise<boolean> {
  const uiLocation = await stackFrame.uiLocation();
  if (!uiLocation) return false;

  if (!uiLocation.source._sourceMapUrl) return false;

  if (!uiLocation.isMapped && uiLocation.unmappedReason !== UnmappedReason.MapDisabled) return true;

  return false;
}

export class SmartStepper {
  private _smartStepCount = 0;

  constructor(private launchConfig: AnyLaunchConfiguration) {}

  private resetSmartStepCount(): void {
    this._smartStepCount = 0;
  }

  async shouldSmartStep(pausedDetails: IPausedDetails): Promise<boolean> {
    if (!this.launchConfig.smartStep) return false;

    const frame = (await pausedDetails.stackTrace.loadFrames(1))[0];
    const should = await shouldSmartStepStackFrame(frame);
    if (should) {
      this._smartStepCount++;
    } else {
      if (this._smartStepCount > 0) {
        logger.verbose(LogTag.Internal, `smartStep: skipped ${this._smartStepCount} steps`);
        this.resetSmartStepCount();
      }
    }

    return should;
  }
}
