/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Thread, ThreadManager } from "./threads";
import { Location } from "./sources";
import Cdp from "../cdp/api";
import { kLogPointUrl } from "./breakpoints";
import Dap from "../dap/api";
import { ScopeRef } from "./variables";
import * as nls from 'vscode-nls';

const localize = nls.loadMessageBundle();

export class StackTrace {
  private _frames: StackFrame[] = [];
  private _frameById: Map<number, StackFrame> = new Map();
  private _asyncStackTraceId?: Cdp.Runtime.StackTraceId;
  private _lastFrameThread?: Thread;
  private _threadManager: ThreadManager;

  public static fromRuntime(thread: Thread, stack: Cdp.Runtime.StackTrace): StackTrace {
    const result = new StackTrace(thread);
    const callFrames = stack.callFrames;
    if (callFrames.length && callFrames[0].url === kLogPointUrl)
      callFrames.splice(0, 1);
    for (const callFrame of stack.callFrames)
      result._frames.push(StackFrame.fromRuntime(thread, callFrame));
    if (stack.parentId) {
      result._asyncStackTraceId = stack.parentId;
      console.assert(!stack.parent);
    } else {
      result._appendStackTrace(thread, stack.parent);
    }
    return result;
  }

  public static fromDebugger(thread: Thread, frames: Cdp.Debugger.CallFrame[], parent?: Cdp.Runtime.StackTrace, parentId?: Cdp.Runtime.StackTraceId): StackTrace {
    const result = new StackTrace(thread);
    for (const callFrame of frames)
      result._appendFrame(StackFrame.fromDebugger(thread, callFrame));
    if (parentId) {
      result._asyncStackTraceId = parentId;
      console.assert(!parent);
    } else {
      result._appendStackTrace(thread, parent);
    }
    return result;
  }

  constructor(thread: Thread) {
    this._lastFrameThread = thread;
    this._threadManager = thread.manager;
  }

  async loadFrames(limit: number): Promise<StackFrame[]> {
    while (this._frames.length < limit && this._asyncStackTraceId) {
      if (this._asyncStackTraceId.debuggerId)
        this._lastFrameThread = this._threadManager.threadForDebuggerId(this._asyncStackTraceId.debuggerId);
      if (!this._lastFrameThread) {
        this._asyncStackTraceId = undefined;
        break;
      }
      const response = await this._lastFrameThread.cdp().Debugger.getStackTrace({ stackTraceId: this._asyncStackTraceId });
      this._asyncStackTraceId = undefined;
      if (response)
        this._appendStackTrace(this._lastFrameThread, response.stackTrace);
    }
    return this._frames;
  }

  frame(frameId: number): StackFrame | undefined {
    return this._frameById.get(frameId);
  }

  _appendStackTrace(thread: Thread, stackTrace: Cdp.Runtime.StackTrace | undefined) {
    console.assert(!stackTrace || !this._asyncStackTraceId);

    while (stackTrace) {
      if (stackTrace.description === 'async function' && stackTrace.callFrames.length)
        stackTrace.callFrames.shift();

      if (stackTrace.callFrames.length) {
        this._appendFrame(StackFrame.asyncSeparator(thread, stackTrace.description || 'async'));
        for (const callFrame of stackTrace.callFrames)
          this._appendFrame(StackFrame.fromRuntime(thread, callFrame));
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
    let to = (params.levels || 50) + from;
    const frames = await this.loadFrames(to);
    to = Math.min(frames.length, params.levels ? to : frames.length);
    const result: Dap.StackFrame[] = [];
    for (let index = from; index < to; index++)
      result.push(await frames[index].toDap());
    return { stackFrames: result, totalFrames: !!this._asyncStackTraceId ? 1000000 : frames.length };
  }
};

export class StackFrame {
  private static _lastFrameId = 0;

  _id: number;
  private _name: string;
  private _location: Promise<Location>;
  private _isAsyncSeparator = false;
  private _scope: { chain: Cdp.Debugger.Scope[], variables: (Dap.Variable | undefined)[], callFrameId: string };
  private _thread: Thread;

  static fromRuntime(thread: Thread, callFrame: Cdp.Runtime.CallFrame): StackFrame {
    return new StackFrame(thread, callFrame.functionName, thread.rawLocationToUiLocation(callFrame));
  }

  static fromDebugger(thread: Thread, callFrame: Cdp.Debugger.CallFrame): StackFrame {
    const result = new StackFrame(thread, callFrame.functionName, thread.rawLocationToUiLocation({
      ...callFrame.location,
      url: callFrame.url,
    }));
    result._scope = {
      chain: callFrame.scopeChain,
      variables: new Array(callFrame.scopeChain.length).fill(undefined),
      callFrameId: callFrame.callFrameId!
    };
    return result;
  }

  static asyncSeparator(thread: Thread, name: string): StackFrame {
    const result = new StackFrame(thread, name, Promise.resolve({ lineNumber: 1, columnNumber: 1, url: '' }));
    result._isAsyncSeparator = true;
    return result;
  }

  constructor(thread: Thread, name: string, location: Promise<Location>) {
    this._id = ++StackFrame._lastFrameId;
    this._name = name || '<anonymous>';
    this._location = location;
    this._thread = thread;
  }

  callFrameId(): string | undefined {
    return this._scope ? this._scope.callFrameId : undefined;
  }

  async scopes(): Promise<Dap.ScopesResult> {
    if (!this._scope)
      return { scopes: [] };

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
        const startLocation = await this._thread.rawLocationToUiLocation(scope.startLocation);
        dap.line = startLocation.lineNumber;
        dap.column = startLocation.columnNumber;
        if (startLocation.source)
          dap.source = await startLocation.source.toDap();
        if (scope.endLocation) {
          const endLocation = await this._thread.rawLocationToUiLocation(scope.endLocation);
          dap.endLine = endLocation.lineNumber;
          dap.endColumn = endLocation.columnNumber;
        }
      }
      scopes.push(dap);
    }

    return { scopes };
  }

  async toDap(): Promise<Dap.StackFrame> {
    const location = await this._location;
    const source = location.source ? await location.source.toDap() : undefined;
    const presentationHint = this._isAsyncSeparator ? 'label' : 'normal';
    return {
      id: this._id,
      name: this._name,
      line: location.lineNumber,
      column: location.columnNumber,
      source,
      presentationHint,
    };
  }

  async format(): Promise<string> {
    if (this._isAsyncSeparator)
      return `◀ ${this._name} ▶`;
    const location = await this._location;
    let prettyName = (location.source && await location.source.prettyName()) || location.url;
    let text = `${prettyName}:${location.lineNumber}`;
    if (location.columnNumber > 1)
      text += `:${location.columnNumber}`;
    return `${this._name} @ ${text}`;
  }

  location(): Promise<Location> {
    return this._location;
  }

  async _scopeVariable(scopeNumber: number): Promise<Dap.Variable> {
    const scope = this._scope!;
    if (!scope.variables[scopeNumber]) {
      const scopeRef: ScopeRef = { callFrameId: scope.callFrameId, scopeNumber };
      const variable = await this._thread.pausedVariables()!.createScope(scope.chain[scopeNumber].object, scopeRef);
      scope.variables[scopeNumber] = variable;
    }
    return scope.variables[scopeNumber]!;
  }

  async completions(): Promise<Dap.CompletionItem[]> {
    if (!this._scope)
      return [];
    const variableStore = this._thread.pausedVariables()!;
    const promises: Promise<Dap.CompletionItem[]>[] = [];
    for (let scopeNumber = 0; scopeNumber < this._scope.chain.length; scopeNumber++) {
      promises.push(this._scopeVariable(scopeNumber).then(async scopeVariable => {
        if (!scopeVariable.variablesReference)
          return [];
        const variables = await variableStore.getVariables({ variablesReference: scopeVariable.variablesReference });
        return variables.map(variable => ({ label: variable.name, type: 'property' }));
      }));
    }
    const completions = await Promise.all(promises);
    return ([] as Dap.CompletionItem[]).concat(...completions);
  }
};
