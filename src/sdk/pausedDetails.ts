// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Cdp from '../cdp/api';
import {Thread} from './thread';
import {Location} from './source';

let stackId = 0;

export type PausedReason = 'step' | 'breakpoint' | 'exception' | 'pause' | 'entry' | 'goto' | 'function breakpoint' | 'data breakpoint';

export type StackFrameType = 'frame' | 'asyncCall' | 'asyncFrame';
export interface StackFrame {
  type: StackFrameType;
  id: number;
  location: Location;
  name: string;
};

export class PausedDetails {
  private _thread: Thread;
  private _details: {reason: PausedReason, description: string, text?: string};
  private _stackTrace: StackFrame[];
  private _asyncStackTraceId?: Cdp.Runtime.StackTraceId;

  constructor(thread: Thread, event: Cdp.Debugger.PausedEvent) {
    this._thread = thread;
    this._details = this._calculateDetails(event);
    this._calculateStackTrace(event);
  }


  reason(): PausedReason {
    return this._details.reason;
  }

  description(): string {
    return this._details.description;
  }

  text(): string | undefined {
    return this._details.text;
  }

  thread(): Thread {
    return this._thread;
  }

  stackTrace(): StackFrame[] {
    return this._stackTrace;
  }

  async loadStackTrace(limit: number): Promise<StackFrame[]> {
    while (this._stackTrace.length < limit && this._asyncStackTraceId) {
      const {stackTrace} = await this._thread.cdp().Debugger.getStackTrace({stackTraceId: this._asyncStackTraceId});
      this._asyncStackTraceId = undefined;
      this._appendStackTrace(stackTrace);
    }
    return this._stackTrace;
  }

  canLoadMoreFrames(): boolean {
    return !!this._asyncStackTraceId;
  }

  _calculateDetails(event: Cdp.Debugger.PausedEvent): ({reason: PausedReason, description: string, text?: string}) {
    // TODO(dgozman): fill "text" with more details.
    switch (event.reason) {
      case 'assert': return {reason: 'exception', description: 'Paused on assert'};
      case 'debugCommand': return {reason: 'pause', description: 'Paused on debug() call'};
      case 'DOM': return {reason: 'data breakpoint', description: 'Paused on DOM breakpoint'};
      case 'EventListener': return {reason: 'function breakpoint', description: 'Paused on event listener breakpoint'};
      case 'exception': return {reason: 'exception', description: 'Paused on exception'};
      case 'promiseRejection': return {reason: 'exception', description: 'Paused on promise rejection'};
      case 'instrumentation': return {reason: 'function breakpoint', description: 'Paused on function call'};
      case 'XHR': return {reason: 'data breakpoint', description: 'Paused on XMLHttpRequest or fetch'};
      case 'OOM': return {reason: 'exception', description: 'Paused before Out Of Memory exception'};
      default: return {reason: 'step', description: 'Paused'};
    }
  }

  _calculateStackTrace(event: Cdp.Debugger.PausedEvent) {
    this._stackTrace = [];
    for (const callFrame of event.callFrames) {
      this._stackTrace.push({
        type: 'frame',
        id: ++stackId,
        location: this._thread.rawLocation(callFrame),
        name: callFrame.functionName || '<anonymous>'
      });
    }

    if (event.asyncStackTraceId) {
      this._asyncStackTraceId = event.asyncStackTraceId;
      console.assert(!event.asyncStackTrace);
    }

    if (event.asyncStackTrace)
      this._appendStackTrace(event.asyncStackTrace);
  }

  _appendStackTrace(stackTrace: Cdp.Runtime.StackTrace) {
    while (stackTrace) {
      if (stackTrace.description === 'async function' && stackTrace.callFrames.length)
        stackTrace.callFrames.shift();

      if (stackTrace.callFrames.length) {
        this._stackTrace.push({
          type: 'asyncCall',
          id: ++stackId,
          name: stackTrace.description || 'async',
          location: {
            lineNumber: 1,
            columnNumber: 1,
            url: '',
          }
        });

        for (const callFrame of stackTrace.callFrames) {
          this._stackTrace.push({
            type: 'asyncFrame',
            id: ++stackId,
            location: this._thread.rawLocation(callFrame),
            name: callFrame.functionName || '<anonymous>'
          });
        }
      }

      if (stackTrace.parentId) {
        this._asyncStackTraceId = stackTrace.parentId;
        console.assert(!stackTrace.parent);
      }

      stackTrace = stackTrace.parent;
    }
  }
};
