/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {Thread} from "./threads";
import {Location} from "./sources";
import Cdp from "../cdp/api";
import {kLogPointUrl} from "./breakpoints";
import Dap from "../dap/api";
import {ScopeRef} from "./variables";
import * as nls from 'vscode-nls';

const localize = nls.loadMessageBundle();

export interface StackFrame {
  id: number;
  name: string;
  location: Location;
  isAsyncSeparator?: boolean;
  scopeChain?: Cdp.Debugger.Scope[];
  callFrameId?: Cdp.Debugger.CallFrameId;
};

export class StackTrace {
  private static _lastFrameId = 0;
  private _thread: Thread;
  private _frames: StackFrame[] = [];
  private _frameById: Map<number, StackFrame> = new Map();
  private _asyncStackTraceId?: Cdp.Runtime.StackTraceId;

  public static fromRuntime(thread: Thread, stack: Cdp.Runtime.StackTrace): StackTrace {
    const result = new StackTrace(thread);
    const callFrames = stack.callFrames;
    if (callFrames.length && callFrames[0].url === kLogPointUrl)
      callFrames.splice(0, 1);
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
        scopeChain: callFrame.scopeChain,
        callFrameId: callFrame.callFrameId,
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

  frame(frameId: number): StackFrame | undefined {
    return this._frameById.get(frameId);
  }

  thread(): Thread {
    return this._thread;
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
    const stackFrames = await this.loadFrames(50);
    const promises = stackFrames.map(async frame => {
      if (frame.isAsyncSeparator)
        return `◀ ${frame.name} ▶`;
      const uiLocation = this._thread.sourceContainer.uiLocation(frame.location);
      let fileName = uiLocation.url;
      if (uiLocation.source) {
        const source = await uiLocation.source.toDap();
        fileName = source.path || fileName;
      }
      let location = `${fileName}:${uiLocation.lineNumber}`;
      if (uiLocation.columnNumber > 1)
        location += `:${uiLocation.columnNumber}`;
      return `${frame.name} @ ${location}`;
    });
    return (await Promise.all(promises)).join('\n') + '\n';
  }

  async toDap(params: Dap.StackTraceParams): Promise<Dap.StackTraceResult> {
    const from = params.startFrame || 0;
    let to = params.levels ? from + params.levels : from + 1;
    const frames = await this.loadFrames(to);
    to = Math.min(frames.length, params.levels ? to : frames.length);
    const result: Dap.StackFrame[] = [];
    for (let index = from; index < to; index++) {
      const stackFrame = frames[index];
      const uiLocation = this._thread.sourceContainer.uiLocation(stackFrame.location);
      const source = uiLocation.source ? await uiLocation.source.toDap() : undefined;
      const presentationHint = stackFrame.isAsyncSeparator ? 'label' : 'normal';
      result.push({
        id: stackFrame.id,
        name: stackFrame.name,
        line: uiLocation.lineNumber,
        column: uiLocation.columnNumber,
        source,
        presentationHint,
      });
    }
    return {stackFrames: result, totalFrames: !!this._asyncStackTraceId ? 1000000 : frames.length};
  }

  async scopes(frameId: number): Promise<Dap.ScopesResult> {
    const stackFrame = this.frame(frameId);
    if (!stackFrame || !stackFrame.scopeChain)
      return {scopes: []};

    const scopes: Dap.Scope[] = [];
    for (let index = 0; index < stackFrame.scopeChain.length; index++) {
      const scope = stackFrame.scopeChain[index];

      let name: string = '';
      let presentationHint: 'arguments' | 'locals' | 'registers' | undefined;
      switch (scope.type) {
        case 'global':
          name = localize('scope.global', 'Global');
          break;
        case 'local':
          name = localize('scope.local', 'Local');
          presentationHint = 'locals';
          break;
        case 'with':
          name = localize('scope.with', 'With Block');
          presentationHint = 'locals';
          break;
        case 'closure':
          name = localize('scope.closure', 'Closure');
          presentationHint = 'arguments';
          break;
        case 'catch':
          name = localize('scope.catch', 'Catch Block');
          presentationHint = 'locals';
          break;
        case 'block':
          name = localize('scope.block', 'Block');
          presentationHint = 'locals';
          break;
        case 'script':
          name = localize('scope.script', 'Script');
          break;
        case 'eval':
          name = localize('scope.eval', 'Eval');
          break;
        case 'module':
          name = localize('scope.module', 'Module');
          break;
      }
      if (scope.name && scope.type === 'closure') {
        name = localize('scope.closureNamed', 'Closure ({0})', scope.name);
      } else if (scope.name) {
        name = scope.name;
      }

      const scopeRef: ScopeRef = {callFrameId: stackFrame.callFrameId!, scopeNumber: index};
      const variable = await this._thread.pausedVariables()!.createScope(scope.object, scopeRef);
      const dap: Dap.Scope = {
        name,
        presentationHint,
        expensive: scope.type === 'global',
        namedVariables: variable.namedVariables,
        indexedVariables: variable.indexedVariables,
        variablesReference: variable.variablesReference,
      };
      if (scope.startLocation) {
        const uiStartLocation = this._thread.sourceContainer.uiLocation(this._thread.locationFromDebugger(scope.startLocation));
        dap.line = uiStartLocation.lineNumber;
        dap.column = uiStartLocation.columnNumber;
        if (uiStartLocation.source)
          dap.source = await uiStartLocation.source.toDap();
        if (scope.endLocation) {
          const uiEndLocation = this._thread.sourceContainer.uiLocation(this._thread.locationFromDebugger(scope.endLocation));
          dap.endLine = uiEndLocation.lineNumber;
          dap.endColumn = uiEndLocation.columnNumber;
        }
      }
      scopes.push(dap);
    }

    return {scopes};
  }
};
