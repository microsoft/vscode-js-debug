/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Cdp from '../cdp/api';
import { IPossibleBreakLocation } from './breakpoints';
import { StackTrace } from './stackTrace';
import { Thread } from './threads';

export type PausedReason =
  | 'step'
  | 'breakpoint'
  | 'exception'
  | 'pause'
  | 'entry'
  | 'goto'
  | 'function breakpoint'
  | 'data breakpoint'
  | 'frame_entry';

export const enum StepDirection {
  In,
  Over,
  Out,
}

export type ExpectedPauseReason =
  | { reason: Exclude<PausedReason, 'step'>; description?: string }
  | { reason: 'step'; description?: string; direction: StepDirection };

export interface IPausedDetails {
  thread: Thread;
  reason: PausedReason;
  event: Cdp.Debugger.PausedEvent;
  description: string;
  stackTrace: StackTrace;
  stepInTargets?: IPossibleBreakLocation[];
  hitBreakpoints?: string[];
  text?: string;
  exception?: Cdp.Runtime.RemoteObject;
}
