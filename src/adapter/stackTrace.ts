/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {Thread} from "./thread";
import {Location, SourceContainer} from "./source";
import Cdp from "../cdp/api";

export interface StackFrame {
  id: number;
  name: string;
  location: Location;
  isAsyncSeparator?: boolean;
  scopeChain?: Cdp.Debugger.Scope[];
};

// TODO(dgozman): use stack trace format.
export class StackTrace {
  private static _lastFrameId = 0;
  private _thread: Thread;
  private _frames: StackFrame[] = [];
  private _frameById: Map<number, StackFrame> = new Map();
  private _asyncStackTraceId?: Cdp.Runtime.StackTraceId;

  public static fromRuntime(thread: Thread, stack: Cdp.Runtime.StackTrace): StackTrace {
    const result = new StackTrace(thread);
    for (const callFrame of stack.callFrames) {
      result._frames.push({
        id: ++StackTrace._lastFrameId,
        location: thread.locationFromRuntimeCallFrame(callFrame),
        name: callFrame.functionName || '<anonymous>'
      });
    }
    if (stack.parentId) {
      result._asyncStackTraceId = stack.parentId;
      console.assert(!stack.parent);
    } else {
      result._appendStackTrace(stack.parent);
    }
    return result;
  }

  public static fromDebugger(thread: Thread, frames: Cdp.Debugger.CallFrame[], parent?: Cdp.Runtime.StackTrace, parentId?: Cdp.Runtime.StackTraceId): StackTrace {
    const result = new StackTrace(thread);
    for (const callFrame of frames) {
      result._appendFrame({
        id: ++StackTrace._lastFrameId,
        location: thread.locationFromDebuggerCallFrame(callFrame),
        name: callFrame.functionName || '<anonymous>',
        scopeChain: callFrame.scopeChain
      });
    }
    if (parentId) {
      result._asyncStackTraceId = parentId;
      console.assert(!parent);
    } else {
      result._appendStackTrace(parent);
    }
    return result;
  }

  constructor(thread: Thread) {
    this._thread = thread;
  }

  async loadFrames(limit: number): Promise<StackFrame[]> {
    while (this._frames.length < limit && this._asyncStackTraceId) {
      const response = await this._thread.cdp().Debugger.getStackTrace({stackTraceId: this._asyncStackTraceId});
      this._asyncStackTraceId = undefined;
      if (response)
        this._appendStackTrace(response.stackTrace);
    }
    return this._frames;
  }

  canLoadMoreFrames(): boolean {
    return !!this._asyncStackTraceId;
  }

  frame(frameId: number): StackFrame | undefined {
    return this._frameById.get(frameId);
  }

  _appendStackTrace(stackTrace: Cdp.Runtime.StackTrace | undefined) {
    console.assert(!stackTrace || !this._asyncStackTraceId);

    while (stackTrace) {
      if (stackTrace.description === 'async function' && stackTrace.callFrames.length)
        stackTrace.callFrames.shift();

      if (stackTrace.callFrames.length) {
        this._appendFrame({
          id: ++StackTrace._lastFrameId,
          name: stackTrace.description || 'async',
          location: {
            lineNumber: 1,
            columnNumber: 1,
            url: '',
          },
          isAsyncSeparator: true
        });

        for (const callFrame of stackTrace.callFrames) {
          this._appendFrame({
            id: ++StackTrace._lastFrameId,
            location: this._thread.locationFromRuntimeCallFrame(callFrame),
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

  _appendFrame(frame: StackFrame) {
    this._frames.push(frame);
    this._frameById.set(frame.id, frame);
  }

  async format(): Promise<string> {
    // This loads all available frames.
    const stackFrames = await this.loadFrames(50);
    const frames: string[] = stackFrames.map(frame => {
      const text = frame.name;
      // TODO(dgozman): use stack trace format.
      // TODO(dgozman): figure out paths vs urls.
      const uiLocation = this._thread.sourceContainer().uiLocation(frame.location);
      let location = `${uiLocation.url}:${uiLocation.lineNumber}`;
      if (uiLocation.columnNumber)
        location += `:${uiLocation.columnNumber}`;
      if (frame.isAsyncSeparator)
        return `    ◀ ${text} ▶`;
      if (uiLocation.url)
        return `    at ${text} (${location})`;
      return `    at ${text}${location}`;
    });
    return frames.join('\n');
  }
};
