/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as nls from 'vscode-nls';
import Cdp from '../cdp/api';
import Dap from '../dap/api';
import { shouldSmartStepStackFrame } from './smartStepping';
import { IPreferredUiLocation } from './sources';
import { RawLocation, Thread } from './threads';
import { IExtraProperty, IScopeRef } from './variables';
import { LogPointCompiler } from './breakpoints/conditions/logPoint';
import { asyncScopesNotAvailable, ProtocolError } from '../dap/errors';

const localize = nls.loadMessageBundle();

export class StackTrace {
  private _frames: StackFrame[] = [];
  private _frameById: Map<number, StackFrame> = new Map();
  private _asyncStackTraceId?: Cdp.Runtime.StackTraceId;
  private _lastFrameThread?: Thread;

  public static fromRuntime(thread: Thread, stack: Cdp.Runtime.StackTrace): StackTrace {
    const result = new StackTrace(thread);
    const callFrames = stack.callFrames;

    // Remove any frames on top that are within a log point.
    while (callFrames.length && LogPointCompiler.isLogPointUrl(callFrames[0].url)) {
      callFrames.splice(0, 1);
    }

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

  public static fromDebugger(
    thread: Thread,
    frames: Cdp.Debugger.CallFrame[],
    parent?: Cdp.Runtime.StackTrace,
    parentId?: Cdp.Runtime.StackTraceId,
  ): StackTrace {
    const result = new StackTrace(thread);
    for (const callFrame of frames) result._appendFrame(StackFrame.fromDebugger(thread, callFrame));
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
  }

  async loadFrames(limit: number): Promise<StackFrame[]> {
    while (this._frames.length < limit && this._asyncStackTraceId) {
      if (this._asyncStackTraceId.debuggerId)
        this._lastFrameThread = Thread.threadForDebuggerId(this._asyncStackTraceId.debuggerId);
      if (!this._lastFrameThread) {
        this._asyncStackTraceId = undefined;
        break;
      }
      const response = await this._lastFrameThread
        .cdp()
        .Debugger.getStackTrace({ stackTraceId: this._asyncStackTraceId });
      this._asyncStackTraceId = undefined;
      if (response) this._appendStackTrace(this._lastFrameThread, response.stackTrace);
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
      result.push(await frames[index].toDap(params.format));
    return {
      stackFrames: result,
      totalFrames: !!this._asyncStackTraceId ? 1000000 : frames.length,
    };
  }
}

interface IScope {
  chain: Cdp.Debugger.Scope[];
  thisObject: Cdp.Runtime.RemoteObject;
  returnValue?: Cdp.Runtime.RemoteObject;
  variables: (Dap.Variable | undefined)[];
  callFrameId: string;
}

export class StackFrame {
  private static _lastFrameId = 0;

  _id: number;
  private _name: string;
  private _rawLocation: RawLocation;
  private _uiLocation: Promise<IPreferredUiLocation | undefined>;
  private _isAsyncSeparator = false;
  private _scope: IScope | undefined;
  private _thread: Thread;

  static fromRuntime(thread: Thread, callFrame: Cdp.Runtime.CallFrame): StackFrame {
    return new StackFrame(thread, callFrame.functionName, thread.rawLocation(callFrame));
  }

  static fromDebugger(thread: Thread, callFrame: Cdp.Debugger.CallFrame): StackFrame {
    const result = new StackFrame(thread, callFrame.functionName, thread.rawLocation(callFrame));
    result._scope = {
      chain: callFrame.scopeChain,
      thisObject: callFrame.this,
      returnValue: callFrame.returnValue,
      variables: new Array(callFrame.scopeChain.length).fill(undefined),
      // eslint-disable-next-line
      callFrameId: callFrame.callFrameId!,
    };
    return result;
  }

  static asyncSeparator(thread: Thread, name: string): StackFrame {
    const result = new StackFrame(thread, name, { lineNumber: 1, columnNumber: 1, url: '' });
    result._isAsyncSeparator = true;
    return result;
  }

  constructor(thread: Thread, name: string, rawLocation: RawLocation) {
    this._id = ++StackFrame._lastFrameId;
    this._name = name || '<anonymous>';
    this._rawLocation = rawLocation;
    this._uiLocation = thread.rawLocationToUiLocation(rawLocation);
    this._thread = thread;
  }

  callFrameId(): string | undefined {
    return this._scope ? this._scope.callFrameId : undefined;
  }

  async scopes(): Promise<Dap.ScopesResult> {
    if (!this._scope) {
      throw new ProtocolError(asyncScopesNotAvailable());
    }

    const scopes: Dap.Scope[] = [];
    for (let scopeNumber = 0; scopeNumber < this._scope.chain.length; scopeNumber++) {
      const scope: Cdp.Debugger.Scope = this._scope.chain[scopeNumber];

      let name = '';
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
        name = `${name}: ${scope.name}`;
      }

      const variable = await this._scopeVariable(scopeNumber, this._scope);
      const dap: Dap.Scope = {
        name,
        presentationHint,
        expensive: scope.type === 'global',
        namedVariables: variable.namedVariables,
        indexedVariables: variable.indexedVariables,
        variablesReference: variable.variablesReference,
      };
      if (scope.startLocation) {
        const startRawLocation = this._thread.rawLocation(scope.startLocation);
        const startUiLocation = await this._thread.rawLocationToUiLocation(startRawLocation);
        dap.line = (startUiLocation || startRawLocation).lineNumber;
        dap.column = (startUiLocation || startRawLocation).columnNumber;
        if (startUiLocation) dap.source = await startUiLocation.source.toDap();
        if (scope.endLocation) {
          const endRawLocation = this._thread.rawLocation(scope.endLocation);
          const endUiLocation = await this._thread.rawLocationToUiLocation(endRawLocation);
          dap.endLine = (endUiLocation || endRawLocation).lineNumber;
          dap.endColumn = (endUiLocation || endRawLocation).columnNumber;
        }
      }
      scopes.push(dap);
    }

    return { scopes };
  }

  async toDap(format?: Dap.StackFrameFormat): Promise<Dap.StackFrame> {
    const uiLocation = await this._uiLocation;
    const source = uiLocation ? await uiLocation.source.toDap() : undefined;
    const isSmartStepped = await shouldSmartStepStackFrame(this);
    const presentationHint = this._isAsyncSeparator
      ? 'label'
      : isSmartStepped
      ? 'deemphasize'
      : 'normal';
    if (isSmartStepped && source)
      source.origin = localize('smartStepSkipLabel', 'Skipped by smartStep');

    const line = (uiLocation || this._rawLocation).lineNumber;
    const column = (uiLocation || this._rawLocation).columnNumber;

    let formattedName = this._name;

    if (source && format) {
      if (format.module) {
        formattedName += ` [${source.name}]`;
      }

      if (format.line) {
        formattedName += ` Line ${line}`;
      }
    }

    return {
      id: this._id,
      name: formattedName, // TODO: Use params to format the name
      line,
      column,
      source,
      presentationHint,
    } as Dap.StackFrame;
  }

  async format(): Promise<string> {
    if (this._isAsyncSeparator) return `◀ ${this._name} ▶`;
    const uiLocation = await this._uiLocation;
    const prettyName =
      (uiLocation && (await uiLocation.source.prettyName())) || this._rawLocation.url;
    const anyLocation = uiLocation || this._rawLocation;
    let text = `${this._name} @ ${prettyName}:${anyLocation.lineNumber}`;
    if (anyLocation.columnNumber > 1) text += `:${anyLocation.columnNumber}`;
    return text;
  }

  uiLocation(): Promise<IPreferredUiLocation | undefined> {
    return this._uiLocation;
  }

  async _scopeVariable(scopeNumber: number, scope: IScope): Promise<Dap.Variable> {
    const existing = scope.variables[scopeNumber];
    if (existing) {
      return existing;
    }

    const scopeRef: IScopeRef = { callFrameId: scope.callFrameId, scopeNumber };
    const extraProperties: IExtraProperty[] = [];
    if (scopeNumber === 0) {
      extraProperties.push({ name: 'this', value: scope.thisObject });
      if (scope.returnValue)
        extraProperties.push({
          name: localize('scope.returnValue', 'Return value'),
          value: scope.returnValue,
        });
    }

    // eslint-disable-next-line
    const variable = await this._thread
      .pausedVariables()!
      .createScope(scope.chain[scopeNumber].object, scopeRef, extraProperties);
    return (scope.variables[scopeNumber] = variable);
  }

  async completions(): Promise<Dap.CompletionItem[]> {
    if (!this._scope) return [];
    const variableStore = this._thread.pausedVariables();
    if (!variableStore) {
      return [];
    }

    const promises: Promise<Dap.CompletionItem[]>[] = [];
    for (let scopeNumber = 0; scopeNumber < this._scope.chain.length; scopeNumber++) {
      promises.push(
        this._scopeVariable(scopeNumber, this._scope).then(async scopeVariable => {
          if (!scopeVariable.variablesReference) return [];
          const variables = await variableStore.getVariables({
            variablesReference: scopeVariable.variablesReference,
          });
          return variables.map(variable => ({ label: variable.name, type: 'property' }));
        }),
      );
    }
    const completions = await Promise.all(promises);
    return ([] as Dap.CompletionItem[]).concat(...completions);
  }
}
