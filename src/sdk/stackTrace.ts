/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {Thread} from "./thread";
import {Location} from "./source";
import Cdp from "../cdp/api";

export type StackFrameType = 'frame' | 'asyncCall' | 'asyncFrame';
export interface StackFrame {
  type: StackFrameType;
  id: number;
  location: Location;
  name: string;
};

export interface DebuggerStackTrace {
  callFrames: Cdp.Debugger.CallFrame[];
  asyncStackTrace?: Cdp.Runtime.StackTrace;
  asyncStackTraceId?: Cdp.Runtime.StackTraceId;
};

// TODO(dgozman): use stack trace format.
export class StackTrace {
  private static _lastFrameId = 0;
  private _thread: Thread;
  private _frames: StackFrame[];
  private _asyncStackTraceId?: Cdp.Runtime.StackTraceId;

  constructor(thread: Thread, stack: Cdp.Runtime.StackTrace | DebuggerStackTrace) {
    this._thread = thread;
    this._frames = [];
    for (const callFrame of stack.callFrames) {
      this._frames.push({
        type: 'frame',
        id: ++StackTrace._lastFrameId,
        location: this._thread.rawLocation(callFrame),
        name: callFrame.functionName || '<anonymous>'
      });
    }

    if ('asyncStackTraceId' in stack) {
      this._asyncStackTraceId = stack.asyncStackTraceId;
      console.assert(!stack.asyncStackTrace);
    } else if ('asyncStackTrace' in stack) {
      this._appendStackTrace(stack.asyncStackTrace);
    }

    if ('parentId' in stack) {
      this._asyncStackTraceId = stack.parentId;
      console.assert(!stack.parent);
    } else if ('parent' in stack) {
      this._appendStackTrace(stack.parent);
    }
  }

  async loadFrames(limit: number): Promise<StackFrame[]> {
    while (this._frames.length < limit && this._asyncStackTraceId) {
      const {stackTrace} = await this._thread.cdp().Debugger.getStackTrace({stackTraceId: this._asyncStackTraceId});
      this._asyncStackTraceId = undefined;
      this._appendStackTrace(stackTrace);
    }
    return this._frames;
  }

  canLoadMoreFrames(): boolean {
    return !!this._asyncStackTraceId;
  }

  _appendStackTrace(stackTrace: Cdp.Runtime.StackTrace) {
    console.assert(!this._asyncStackTraceId);

    while (stackTrace) {
      if (stackTrace.description === 'async function' && stackTrace.callFrames.length)
        stackTrace.callFrames.shift();

      if (stackTrace.callFrames.length) {
        this._frames.push({
          type: 'asyncCall',
          id: ++StackTrace._lastFrameId,
          name: stackTrace.description || 'async',
          location: {
            lineNumber: 1,
            columnNumber: 1,
            url: '',
          }
        });

        for (const callFrame of stackTrace.callFrames) {
          this._frames.push({
            type: 'asyncFrame',
            id: ++StackTrace._lastFrameId,
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
