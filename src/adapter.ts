// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as DAP from './dap';
import * as CDP from './connection';
import {DebugProtocol} from 'vscode-debugprotocol';
import Protocol from 'devtools-protocol';

import {Target, TargetManager, TargetEvents} from './targetManager';
import {findChrome} from './findChrome';
import * as launcher from './launcher';
import {Thread, ThreadEvents} from './thread';

export class Adapter implements DAP.Adapter {
  private _dap: DAP.Connection;
  private _cdp: CDP.Connection;
  private _targetManager: TargetManager;
  private _launchParams: DAP.LaunchParams;

  private _mainTarget: Target;
  private _threads: Map<number, Thread> = new Map();
  private _lastVariableReference: number = 0;
  private _variableToObject: Map<number, Protocol.Runtime.RemoteObjectId> = new Map();
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
    this._cdp = await launcher.launch(
      executablePath, {
        userDataDir: '.profile',
        pipe: true,
      });

    this._targetManager = new TargetManager(this._cdp);
    this._targetManager.on(TargetEvents.TargetAttached, (target: Target) => {
      if (target.thread())
        this._onThreadCreated(target.thread());
    });
    this._targetManager.on(TargetEvents.TargetDetached, (target: Target) => {
      if (target.thread())
        this._onThreadDestroyed(target.thread());
    });

    this._cdp.browserSession().on(CDP.SessionEvents.Disconnected, () => this._dap.didExit(0));

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
      supportsLoadedSourcesRequest: false,
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
    this._cdp.browserSession().send('Browser.close');
  }

  async _load(): Promise<void> {
    if (this._mainTarget && this._launchParams) {
      await this._mainTarget.session().send('Page.navigate', {url: this._launchParams.url});
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
    return {stackFrames: [], totalFrames: 0};
  }

  async getScopes(params: DebugProtocol.ScopesArguments): Promise<DebugProtocol.Scope[]> {
    return [];
  }

  async getVariables(params: DebugProtocol.VariablesArguments): Promise<DebugProtocol.Variable[]> {
    const objectId = this._variableToObject.get(params.variablesReference);
    const getPropertiesParams: Protocol.Runtime.GetPropertiesRequest = {
      objectId,
      ownProperties: true
    };
    const response = await this._mainTarget.session().send('Runtime.getProperties', getPropertiesParams) as Protocol.Runtime.GetPropertiesResponse;
    let properties = response.result;
    if (params.start)
      properties = properties.slice(params.start);
    if (params.count)
      properties.length = params.count;

    return properties.map(p => this._createVariable(p.name, p.value, p));
  }

  _createVariableReference(objectId: Protocol.Runtime.RemoteObjectId): number {
    const reference = ++this._lastVariableReference;
    this._variableToObject.set(reference, objectId);
    this._objectToVariable.set(objectId, reference);
    return reference;
  }

  _createVariable(name: string, value: Protocol.Runtime.RemoteObject, prop?: Protocol.Runtime.PropertyDescriptor): DebugProtocol.Variable {
    let variablesReference = 0;
    let indexedVariables: number | undefined = undefined;
    let namedVariables: number | undefined = undefined;
    if (!value) {
      // TODO(pfeldman): implement getters / setters
      return {
        name,
        value: '',
        variablesReference: 0
      };
    }

    if (value.objectId) {
      variablesReference = this._createVariableReference(value.objectId);
      namedVariables = 100000;
    }
    if (value.subtype === 'array')
      indexedVariables = 1000000;

    let presentationHint: DebugProtocol.VariablePresentationHint = {};
    presentationHint.kind = value.type === 'function' ? 'method' : 'property';
    if (prop && !prop.enumerable)
      presentationHint.visibility = 'private';
    presentationHint.attributes = [];
    if (prop && !prop.configurable)
      presentationHint.attributes.push('constant');
    if (prop && !prop.writable)
      presentationHint.attributes.push('readOnly');

    return {
      name,
      value: value.description,
      type: value.className || value.subtype || value.type,
      variablesReference,
      presentationHint,
      namedVariables,
      indexedVariables
    };
  }

  async evaluate(args: DebugProtocol.EvaluateArguments): Promise<DAP.EvaluateResult> {
    if (!this._mainTarget)
      return {result: '', variablesReference: 0};
    const evaluateParams: Protocol.Runtime.EvaluateRequest = {
      expression: args.expression,
      includeCommandLineAPI: true,
      objectGroup: 'console'
    };
    const response = await this._mainTarget.session().send('Runtime.evaluate', evaluateParams) as Protocol.Runtime.EvaluateResponse;
    if (response.result.objectId) {
      const variable = await this._createVariable('', response.result);
      return {
        result: response.result.description,
        variablesReference: variable.variablesReference,
        namedVariables: variable.namedVariables,
        indexedVariables: variable.indexedVariables,
      };
    }
    return {result: response.result.description, variablesReference: 0};
  }

  async completions(params: DebugProtocol.CompletionsArguments): Promise<DAP.CompletionsResult> {
    if (!this._mainTarget)
      return {targets: []};
    const global = await this._mainTarget.session().send('Runtime.evaluate', {expression: 'self'}) as Protocol.Runtime.EvaluateResponse;
    if (!global)
      return {targets: []};

    const callArg: Protocol.Runtime.CallArgument = {
      value: params.text
    };
    const callParams: Protocol.Runtime.CallFunctionOnRequest = {
      objectId: global.result.objectId,
      functionDeclaration: `function (prefix) {
          return Object.getOwnPropertyNames(this).filter(l => l.startsWith(prefix));
        }`,
      objectGroup: 'console',
      arguments: [callArg],
      returnByValue: true
    };
    const response = await this._mainTarget.session().send('Runtime.callFunctionOn', callParams) as Protocol.Runtime.CallFunctionOnResponse;
    if (!response)
      return {targets: []};

    const completions = response.result.value as string[];
    return {
      targets: completions.map(label => {
        return {label};
      })
    };
  }
}
