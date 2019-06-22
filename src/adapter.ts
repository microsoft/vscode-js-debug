// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as DAP from './dap';
import * as CDP from './connection';
import {DebugProtocol} from 'vscode-debugprotocol';
import Protocol from 'devtools-protocol';

import {Target, TargetManager, TargetEvents} from './targetManager';
import {findChrome} from './findChrome';
import * as launcher from './launcher';
import {Script, Thread, ThreadEvents} from './thread';
import * as variables from './variables';
import ProtocolProxyApi from 'devtools-protocol/types/protocol-proxy-api';

let stackId = 0;

export class Adapter implements DAP.Adapter {
  private _dap: DAP.Connection;
  private _browser: ProtocolProxyApi.ProtocolApi;
  private _targetManager: TargetManager;
  private _launchParams: DAP.LaunchParams;

  private _mainTarget: Target;
  private _threads: Map<number, Thread> = new Map();
  private _scripts: Map<number, Script> = new Map();
  private _lastVariableReference: number = 0;
  private _variableToObject: Map<number, Protocol.Runtime.RemoteObject> = new Map();
  private _objectToVariable: Map<Protocol.Runtime.RemoteObjectId, number> = new Map();

  constructor(dap: DAP.Connection) {
    this._dap = dap;
    dap.setAdapter(this);
  }

  public async initialize(params: DebugProtocol.InitializeRequestArguments): Promise<DebugProtocol.Capabilities> {
    console.assert(params.linesStartAt1);
    console.assert(params.columnsStartAt1);
    console.assert(params.pathFormat === 'path');

    const executablePath = findChrome().pop();
    const connection = await launcher.launch(
      executablePath, {
        userDataDir: '.profile',
        pipe: true,
      });

    this._targetManager = new TargetManager(connection);
    this._targetManager.on(TargetEvents.TargetAttached, (target: Target) => {
      if (target.thread())
        this._onThreadCreated(target.thread());
    });
    this._targetManager.on(TargetEvents.TargetDetached, (target: Target) => {
      if (target.thread())
        this._onThreadDestroyed(target.thread());
    });

    connection.on(CDP.ConnectionEvents.Disconnected, () => this._dap.didExit(0));

    // params.locale || 'en-US'
    // params.supportsVariableType
    // params.supportsVariablePaging
    // params.supportsRunInTerminalRequest
    // params.supportsMemoryReferences

    this._dap.didInitialize();
    return {
      supportsConfigurationDoneRequest: false,
      supportsFunctionBreakpoints: false,
      supportsConditionalBreakpoints: false,
      supportsHitConditionalBreakpoints: false,
      supportsEvaluateForHovers: false,
      exceptionBreakpointFilters: [],
      supportsStepBack: false,
      supportsSetVariable: false,
      supportsRestartFrame: false,
      supportsGotoTargetsRequest: false,
      supportsStepInTargetsRequest: false,
      supportsCompletionsRequest: true,
      supportsModulesRequest: false,
      additionalModuleColumns: [],
      supportedChecksumAlgorithms: [],
      supportsRestartRequest: true,
      supportsExceptionOptions: false,
      supportsValueFormattingOptions: false,
      supportsExceptionInfoRequest: false,
      supportTerminateDebuggee: false,
      supportsDelayedStackTraceLoading: false,
      supportsLoadedSourcesRequest: true,
      supportsLogPoints: false,
      supportsTerminateThreadsRequest: false,
      supportsSetExpression: false,
      supportsTerminateRequest: false,
      //supportsDataBreakpoints: false,
      //supportsReadMemoryRequest: false,
      //supportsDisassembleRequest: false,
    };
  }

  _onThreadCreated(thread: Thread): void {
    console.assert(!this._threads.has(thread.threadId()));
    this._threads.set(thread.threadId(), thread);
    this._dap.didChangeThread('started', thread.threadId());

    const onPaused = () => {
      const details = thread.pausedDetails();
      this._dap.didPause({
        reason: details.reason,
        description: 'didPause.description',
        threadId: thread.threadId(),
        text: 'didPause.text'
      });
    };
    thread.on(ThreadEvents.ThreadPaused, onPaused);
    if (thread.pausedDetails())
      onPaused();

    thread.on(ThreadEvents.ThreadResumed, () => {
      this._dap.didResume(thread.threadId());
    });

    const onScriptParsed = (script: Script) => {
      this._scripts.set(script.sourceReference(), script);
      this._dap.didChangeScript('new', script.toDap());
    };
    thread.on(ThreadEvents.ScriptAdded, onScriptParsed);
    for (const script of thread.scripts().values())
      onScriptParsed(script);
    thread.on(ThreadEvents.ScriptsRemoved, (scripts: Script[]) => {
      for (const script of scripts)
        this._dap.didChangeScript('removed', script.toDap());
    });
  }

  _onThreadDestroyed(thread: Thread): void {
    this._threads.delete(thread.threadId());
    this._dap.didChangeThread('exited', thread.threadId());
  }

  async launch(params: DAP.LaunchParams): Promise<void> {
    // params.noDebug
    this._launchParams = params;
    this._mainTarget = this._targetManager.mainTarget();
    if (!this._mainTarget)
      this._mainTarget = await new Promise(f => this._targetManager.once(TargetEvents.TargetAttached, f));
    this._targetManager.on(TargetEvents.TargetDetached, (target: Target) => {
      if (target === this._mainTarget) {
        this._dap.didTerminate();
      }
    });
    await this._load();
  }

  async terminate(params: DebugProtocol.TerminateArguments): Promise<void> {
  }

  async disconnect(params: DebugProtocol.DisconnectArguments): Promise<void> {
    this._browser.Browser.close();
  }

  async _load(): Promise<void> {
    if (this._mainTarget && this._launchParams) {
      await this._mainTarget.cdp().Page.navigate({url: this._launchParams.url});
    }
  }

  async restart(params: DebugProtocol.RestartArguments): Promise<void> {
    this._load();
  }

  async getThreads(): Promise<DebugProtocol.Thread[]> {
    const result = [];
    for (const thread of this._threads.values())
      result.push(thread.toDap());
    return result;
  }

  async continue(params: DebugProtocol.ContinueArguments): Promise<void> {
    const thread = this._threads.get(params.threadId);
    if (thread)
      thread.resume();
  }

  async getStackTrace(params: DebugProtocol.StackTraceArguments): Promise<DAP.StackTraceResult> {
    const thread = this._threads.get(params.threadId);
    if (!thread || !thread.pausedDetails())
      return {stackFrames: [], totalFrames: 0};
    const details = thread.pausedDetails()!;
    const result: DebugProtocol.StackFrame[] = [];

    for (const callFrame of details.callFrames) {
      const stackFrame: DebugProtocol.StackFrame = {
        id: ++stackId,
        name: callFrame.functionName || '<anonymous>',
        line: callFrame.location.lineNumber + 1,
        column: (callFrame.location.columnNumber || 0) + 1,
        presentationHint: 'normal'
      };
      const script = thread.scripts().get(callFrame.location.scriptId);
      if (script) {
        stackFrame.source = script.toDap();
      } else {
        stackFrame.source = {name: 'unknown'};
      }
      result.push(stackFrame);
    }

    let asyncParent = details.asyncStackTrace;
    while (asyncParent) {
      if (asyncParent.description === 'async function' && asyncParent.callFrames.length)
        asyncParent.callFrames.shift();

      if (!asyncParent.callFrames.length) {
        asyncParent = asyncParent.parent;
        continue;
      }

      result.push({
        id: ++stackId,
        name: asyncParent.description || 'async',
        line: 1,
        column: 1,
        presentationHint: 'label'
      });

      for (const callFrame of asyncParent.callFrames) {
        const stackFrame: DebugProtocol.StackFrame = {
          id: ++stackId,
          name: callFrame.functionName || '<anonymous>',
          line: callFrame.lineNumber + 1,
          column: (callFrame.columnNumber || 0) + 1,
          presentationHint: 'normal'
        };
        const script = thread.scripts().get(callFrame.scriptId);
        if (script) {
          stackFrame.source = script.toDap();
        } else {
          stackFrame.source = {name: callFrame.url};
        }
        result.push(stackFrame);
      }
      asyncParent = asyncParent.parent;
    }

    return {stackFrames: result, totalFrames: result.length};
  }

  async getScopes(params: DebugProtocol.ScopesArguments): Promise<DebugProtocol.Scope[]> {
    return [];
  }

  async getVariables(params: DebugProtocol.VariablesArguments): Promise<DebugProtocol.Variable[]> {
    const object = this._variableToObject.get(params.variablesReference);
    if (object.subtype === 'array') {
      if (params.filter === 'indexed')
        return this._getArraySlots(params, object);
      if (params.filter === 'named')
        return this._getArrayProperties(params, object);
      const indexes = await this._getArrayProperties(params, object);
      const names = await this._getArraySlots(params, object);
      return names.concat(indexes);
    }
    return this._getObjectProperties(object);
  }

  async _getObjectProperties(object: Protocol.Runtime.RemoteObject): Promise<DebugProtocol.Variable[]> {
    const response = await this._mainTarget.cdp().Runtime.getProperties({
      objectId: object.objectId,
      ownProperties: true,
      generatePreview: true
    });
    const properties = [];
    for (const p of response.result)
      properties.push(this._createVariable(p.name, p.value));
    for (const p of (response.privateProperties || []))
      properties.push(this._createVariable(p.name, p.value));
    // for (const p of (response.internalProperties || []))
    //   properties.push(this._createVariable(p.name, p.value));
    return Promise.all(properties);
  }

  async _getArrayProperties(params: DebugProtocol.VariablesArguments, object: Protocol.Runtime.RemoteObject): Promise<DebugProtocol.Variable[]> {
    const response = await this._mainTarget.cdp().Runtime.callFunctionOn({
      objectId: object.objectId,
      functionDeclaration: `
        function() {
          const result = {__proto__: this.__proto__};
          const names = Object.getOwnPropertyNames(this);
          for (let i = 0; i < names.length; ++i) {
            const name = names[i];
            // Array index check according to the ES5-15.4.
            if (String(name >>> 0) === name && name >>> 0 !== 0xffffffff)
              continue;
            const descriptor = Object.getOwnPropertyDescriptor(this, name);
            if (descriptor)
              Object.defineProperty(result, name, descriptor);
          }
          return result;
        }`,
      generatePreview: true
    });
    return this._getObjectProperties(response.result);
  }

  async _getArraySlots(params: DebugProtocol.VariablesArguments, object: Protocol.Runtime.RemoteObject): Promise<DebugProtocol.Variable[]> {
    const response = await this._mainTarget.cdp().Runtime.callFunctionOn({
      objectId: object.objectId,
      functionDeclaration: `
        function(start, count) {
          const result = {};
          for (let i = start; i < start + count; ++i) {
            const descriptor = Object.getOwnPropertyDescriptor(this, i);
            if (descriptor)
              Object.defineProperty(result, i, descriptor);
            else
              result[i] = undefined;
          }
          return result;
        }
      `,
      generatePreview: true,
      arguments: [ { value: params.start }, { value: params.count } ]
    });
    const result = (await this._getObjectProperties(response.result)).filter(p => p.name !== '__proto__');
    return result;
  }

  _createVariableReference(object: Protocol.Runtime.RemoteObject): number {
    const reference = ++this._lastVariableReference;
    this._variableToObject.set(reference, object);
    this._objectToVariable.set(object.objectId, reference);
    return reference;
  }

  async _createVariable(name: string, value: Protocol.Runtime.RemoteObject, context?: string): Promise<DebugProtocol.Variable> {
    if (!value) {
      // TODO(pfeldman): implement getters / setters
      return {
        name,
        value: '',
        variablesReference: 0
      };
    }

    if (value.subtype === 'array')
      return this._createArrayVariable(name, value, context);
    if (value.objectId)
      return this._createObjectVariable(name, value, context);
    return this._createPrimitiveVariable(name, value, context);
  }

  async _createPrimitiveVariable(name: string, value: Protocol.Runtime.RemoteObject, context?: string): Promise<DebugProtocol.Variable> {
    return {
      name,
      value: variables.previewRemoteObject(value, context),
      type: value.type,
      variablesReference: 0
    };
  }

  async _createObjectVariable(name: string, value: Protocol.Runtime.RemoteObject, context?: string): Promise<DebugProtocol.Variable> {
    const variablesReference = this._createVariableReference(value);
    return {
      name,
      value: name === '__proto__' && value.description === 'Object' ? value.description : variables.previewRemoteObject(value, context),
      type: value.className || value.subtype || value.type,
      variablesReference
    };
  }

  async _createArrayVariable(name: string, value: Protocol.Runtime.RemoteObject, context?: string): Promise<DebugProtocol.Variable> {
    const variablesReference = this._createVariableReference(value);
    const response = await this._mainTarget.cdp().Runtime.callFunctionOn({
      objectId: value.objectId,
      functionDeclaration: `function (prefix) {
          return this.length;
        }`,
      objectGroup: 'console',
      returnByValue: true
    });
    const indexedVariables = response.result.value;

    return {
      name,
      value: variables.previewRemoteObject(value, context),
      type: value.className || value.subtype || value.type,
      variablesReference,
      indexedVariables
    };
  }

  async evaluate(args: DebugProtocol.EvaluateArguments): Promise<DAP.EvaluateResult> {
    if (!this._mainTarget)
      return {result: '', variablesReference: 0};
    const response = await this._mainTarget.cdp().Runtime.evaluate({
      expression: args.expression,
      includeCommandLineAPI: true,
      objectGroup: 'console',
      generatePreview: true
    });
    const variable = await this._createVariable('', response.result, args.context);
    return {
      result: variable.value,
      variablesReference: variable.variablesReference,
      namedVariables: variable.namedVariables,
      indexedVariables: variable.indexedVariables,
    };
  }

  async completions(params: DebugProtocol.CompletionsArguments): Promise<DAP.CompletionsResult> {
    if (!this._mainTarget)
      return {targets: []};
    const global = await this._mainTarget.cdp().Runtime.evaluate({expression: 'self'});
    if (!global)
      return {targets: []};

    const callArg: Protocol.Runtime.CallArgument = {
      value: params.text
    };
    const response = await this._mainTarget.cdp().Runtime.callFunctionOn({
      objectId: global.result.objectId,
      functionDeclaration: `function (prefix) {
          return Object.getOwnPropertyNames(this).filter(l => l.startsWith(prefix));
        }`,
      objectGroup: 'console',
      arguments: [callArg],
      returnByValue: true
    });
    if (!response)
      return {targets: []};

    const completions = response.result.value as string[];
    return {
      targets: completions.map(label => {
        return {label};
      })
    };
  }

  async getScripts(params: DebugProtocol.LoadedSourcesArguments): Promise<DebugProtocol.Source[]> {
    const sources = [];
    for (const thread of this._threads.values()) {
      for (const script of thread.scripts().values())
        sources.push(script.toDap());
    }
    return sources;
  }

  async getScriptSource(params: DebugProtocol.SourceArguments): Promise<DAP.GetScriptSourceResult> {
    const script = this._scripts.get(params.sourceReference);
    if (!script)
      return {content: '', mimeType: 'text/javascript'};
    return {content: await script.source(), mimeType: 'text/javascript'};
  }
}
