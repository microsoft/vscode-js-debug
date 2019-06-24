/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as DAP from './dap';
import * as CDP from './connection';
import {DebugProtocol} from 'vscode-debugprotocol';
import Protocol from 'devtools-protocol';

import {Target, TargetManager, TargetEvents} from './targetManager';
import {findChrome} from './findChrome';
import * as launcher from './launcher';
import {Thread, ThreadEvents} from './thread';
import {VariableStore} from './variableStore';
import ProtocolProxyApi from 'devtools-protocol/types/protocol-proxy-api';
import {Source, SourceContainer} from './source';

let stackId = 0;

export class Adapter implements DAP.Adapter {
  private _dap: DAP.Connection;
  private _browser: ProtocolProxyApi.ProtocolApi;
  private _sourceContainer: SourceContainer;
  private _targetManager: TargetManager;
  private _launchParams: DAP.LaunchParams;

  private _mainTarget: Target;
  private _threads: Map<number, Thread> = new Map();
  private _variableStore = new VariableStore();

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

    this._sourceContainer = new SourceContainer();
    this._targetManager = new TargetManager(connection, this._sourceContainer);
    this._targetManager.on(TargetEvents.TargetAttached, (target: Target) => {
      if (target.thread())
        this._onThreadCreated(target.thread());
    });
    this._targetManager.on(TargetEvents.TargetDetached, (target: Target) => {
      if (target.thread())
        this._onThreadDestroyed(target.thread());
    });
    this._browser = connection.browser();

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

    const onSource = (source: Source) => {
      this._dap.didChangeScript('new', source.toDap());
    };
    this._sourceContainer.on(SourceContainer.Events.SourceAdded, onSource);
    this._sourceContainer.sources().forEach(onSource);
    this._sourceContainer.on(SourceContainer.Events.SourcesRemoved, (sources: Source[]) => {
      for (const source of sources)
        this._dap.didChangeScript('removed', source.toDap());
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
    return this._variableStore.getVariables(params);
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
    const variable = await this._variableStore.createVariable(this._mainTarget.cdp(), response.result, args.context);
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

  async getSources(params: DebugProtocol.LoadedSourcesArguments): Promise<DebugProtocol.Source[]> {
    return this._sourceContainer.sources().map(source => source.toDap());
  }

  async getSourceContent(params: DebugProtocol.SourceArguments): Promise<DAP.GetSourceContentResult> {
    const source = this._sourceContainer.source(params.sourceReference);
    if (!source)
      return {content: '', mimeType: 'text/javascript'};
    return {content: await source.content(), mimeType: source.mimeType()};
  }
}
