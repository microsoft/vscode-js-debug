// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {Thread} from "./threads";
import {Location} from "./sources";
import Cdp from "../cdp/api";
import {kLogPointUrl} from "./breakpoints";
import Dap from "../dap/api";
import {ScopeRef} from "./variables";
import * as nls from 'vscode-nls';

const localize = nls.loadMessageBundle();

export class StackTrace {
  _thread: Thread;
  private _frames: StackFrame[] = [];
  private _frameById: Map<number, StackFrame> = new Map();
  private _asyncStackTraceId?: Cdp.Runtime.StackTraceId;

  public static fromRuntime(thread: Thread, stack: Cdp.Runtime.StackTrace): StackTrace {
    const result = new StackTrace(thread);
    const callFrames = stack.callFrames;
    if (callFrames.length && callFrames[0].url === kLogPointUrl)
      callFrames.splice(0, 1);
    for (const callFrame of stack.callFrames)
      result._frames.push(StackFrame.fromRuntime(result, callFrame));
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
    for (const callFrame of frames)
      result._appendFrame(StackFrame.fromDebugger(result, callFrame));
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
        this._appendFrame(StackFrame.asyncSeparator(this, stackTrace.description || 'async'));
        for (const callFrame of stackTrace.callFrames)
          this._appendFrame(StackFrame.fromRuntime(this, callFrame));
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
    this._frameById.set(frame._id, frame);
  }

  async format(): Promise<string> {
    const stackFrames = await this.loadFrames(50);
    const promises = stackFrames.map(frame => frame.format());
    return (await Promise.all(promises)).join('\n') + '\n';
  }

  async toDap(params: Dap.StackTraceParams): Promise<Dap.StackTraceResult> {
    const from = params.startFrame || 0;
    let to = params.levels ? from + params.levels : from + 1;
    const frames = await this.loadFrames(to);
    to = Math.min(frames.length, params.levels ? to : frames.length);
    const result: Dap.StackFrame[] = [];
    for (let index = from; index < to; index++)
      result.push(await frames[index].toDap());
    return {stackFrames: result, totalFrames: !!this._asyncStackTraceId ? 1000000 : frames.length};
  }
};

export class StackFrame {
  private static _lastFrameId = 0;

  _id: number;
  private _name: string;
  private _location: Location;
  private _isAsyncSeparator = false;
  private _scope: {chain: Cdp.Debugger.Scope[], variables: (Dap.Variable | undefined)[], callFrameId: string};
  private _stack: StackTrace;

  static fromRuntime(stack: StackTrace, callFrame: Cdp.Runtime.CallFrame): StackFrame {
    return new StackFrame(stack, callFrame.functionName, stack._thread.locationFromRuntimeCallFrame(callFrame));
  }

  static fromDebugger(stack: StackTrace, callFrame: Cdp.Debugger.CallFrame): StackFrame {
    const result = new StackFrame(stack, callFrame.functionName, stack._thread.locationFromDebuggerCallFrame(callFrame));
    result._scope = {
      chain: callFrame.scopeChain,
      variables: new Array(callFrame.scopeChain.length).fill(undefined),
      callFrameId: callFrame.callFrameId!
    };
    return result;
  }

  static asyncSeparator(stack: StackTrace, name: string): StackFrame {
    const result = new StackFrame(stack, name, {lineNumber: 1, columnNumber: 1, url: ''});
    result._isAsyncSeparator = true;
    return result;
  }

  constructor(stack: StackTrace, name: string, location: Location) {
    this._id = ++StackFrame._lastFrameId;
    this._name = name || '<anonymous>';
    this._location = location;
    this._stack = stack;
  }

  stackTrace(): StackTrace {
    return this._stack;
  }

  thread(): Thread {
    return this._stack._thread;
  }

  callFrameId(): string | undefined {
    return this._scope ? this._scope.callFrameId : undefined;
  }

  async scopes(): Promise<Dap.ScopesResult> {
    if (!this._scope)
      return {scopes: []};

    const scopes: Dap.Scope[] = [];
    for (let scopeNumber = 0; scopeNumber < this._scope.chain.length; scopeNumber++) {
      const scope = this._scope.chain[scopeNumber];

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

      const variable = await this._scopeVariable(scopeNumber);
      const dap: Dap.Scope = {
        name,
        presentationHint,
        expensive: scope.type === 'global',
        namedVariables: variable.namedVariables,
        indexedVariables: variable.indexedVariables,
        variablesReference: variable.variablesReference,
      };
      if (scope.startLocation) {
        const uiStartLocation = this.thread().sourceContainer.uiLocation(this.thread().locationFromDebugger(scope.startLocation));
        dap.line = uiStartLocation.lineNumber;
        dap.column = uiStartLocation.columnNumber;
        if (uiStartLocation.source)
          dap.source = await uiStartLocation.source.toDap();
        if (scope.endLocation) {
          const uiEndLocation = this.thread().sourceContainer.uiLocation(this.thread().locationFromDebugger(scope.endLocation));
          dap.endLine = uiEndLocation.lineNumber;
          dap.endColumn = uiEndLocation.columnNumber;
        }
      }
      scopes.push(dap);
    }

    return {scopes};
  }

  async toDap(): Promise<Dap.StackFrame> {
    const uiLocation = this.thread().sourceContainer.uiLocation(this._location);
    const source = uiLocation.source ? await uiLocation.source.toDap() : undefined;
    const presentationHint = this._isAsyncSeparator ? 'label' : 'normal';
    return {
      id: this._id,
      name: this._name,
      line: uiLocation.lineNumber,
      column: uiLocation.columnNumber,
      source,
      presentationHint,
    };
  }

  async format(): Promise<string> {
    if (this._isAsyncSeparator)
      return `◀ ${this._name} ▶`;
    const uiLocation = this.uiLocation();
    let fileName = uiLocation.url;
    if (uiLocation.source) {
      const source = await uiLocation.source.toDap();
      fileName = source.path || fileName;
    }
    let location = `${fileName}:${uiLocation.lineNumber}`;
    if (uiLocation.columnNumber > 1)
      location += `:${uiLocation.columnNumber}`;
    return `${this._name} @ ${location}`;
  }

  uiLocation(): Location {
    return this.thread().sourceContainer.uiLocation(this._location);
  }

  async _scopeVariable(scopeNumber: number): Promise<Dap.Variable> {
    const scope = this._scope!;
    if (!scope.variables[scopeNumber]) {
      const scopeRef: ScopeRef = {callFrameId: scope.callFrameId, scopeNumber};
      const variable = await this.thread().pausedVariables()!.createScope(scope.chain[scopeNumber].object, scopeRef);
      scope.variables[scopeNumber] = variable;
    }
    return scope.variables[scopeNumber]!;
  }

  async completions(): Promise<Dap.CompletionItem[]> {
    if (!this._scope)
      return [];
    const variableStore = this._stack._thread.pausedVariables()!;
    const promises: Promise<Dap.CompletionItem[]>[] = [];
    for (let scopeNumber = 0; scopeNumber < this._scope.chain.length; scopeNumber++) {
      promises.push(this._scopeVariable(scopeNumber).then(async scopeVariable => {
        if (!scopeVariable.variablesReference)
          return [];
        const variables = await variableStore.getVariables({variablesReference: scopeVariable.variablesReference});
        return variables.map(variable => ({label: variable.name, type: 'property'}));
      }));
    }
    const completions = await Promise.all(promises);
    return ([] as Dap.CompletionItem[]).concat(...completions);
  }
};
