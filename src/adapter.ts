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
import {URL} from 'url';
import * as path from 'path';
import * as completionz from './completions';
import {Thread, ThreadEvents} from './thread';
import {VariableStore} from './variableStore';
import ProtocolProxyApi from 'devtools-protocol/types/protocol-proxy-api';
import {Source, SourceContainer} from './source';

let stackId = 0;

interface Location {
  lineNumber: number;
  columnNumber: number;
  url: string;
  scriptId?: string;
  thread?: Thread;
};

interface ResolvedLocation {
  lineNumber: number;
  columnNumber: number;
  url: string;
  source?: Source;
};

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

  async initialize(params: DebugProtocol.InitializeRequestArguments): Promise<DebugProtocol.Capabilities> {
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
      supportsConfigurationDoneRequest: true,
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

  async configurationDone(params: DebugProtocol.ConfigurationDoneArguments): Promise<void> {
    this._mainTarget = this._targetManager.mainTarget();
    if (!this._mainTarget)
      this._mainTarget = await new Promise(f => this._targetManager.once(TargetEvents.TargetAttached, f));
    this._targetManager.on(TargetEvents.TargetDetached, (target: Target) => {
      if (target === this._mainTarget) {
        this._dap.didTerminate();
      }
    });

    const onSource = (source: Source) => {
      this._dap.didChangeScript('new', this._sourceToDap(source));
    };
    this._sourceContainer.on(SourceContainer.Events.SourceAdded, onSource);
    this._sourceContainer.sources().forEach(onSource);
    this._sourceContainer.on(SourceContainer.Events.SourcesRemoved, (sources: Source[]) => {
      for (const source of sources)
        this._dap.didChangeScript('removed', this._sourceToDap(source));
    });
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
    if (!this._mainTarget)
      await this.configurationDone({});

    // params.noDebug
    this._launchParams = params;
    this._mainTarget.cdp().Page.navigate({url: this._launchParams.url});
  }

  async terminate(params: DebugProtocol.TerminateArguments): Promise<void> {
    this._mainTarget.cdp().Page.navigate({url: 'about:blank'});
  }

  async disconnect(params: DebugProtocol.DisconnectArguments): Promise<void> {
    this._browser.Browser.close();
  }

  async restart(params: DebugProtocol.RestartArguments): Promise<void> {
    this._mainTarget.cdp().Page.navigate({url: this._launchParams.url});
  }

  async getThreads(): Promise<DebugProtocol.Thread[]> {
    const result = [];
    for (const thread of this._threads.values())
      result.push({id: thread.threadId(), name: thread.threadName()});
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
      const location = this._sourceContainer.uiLocation({
        url: callFrame.url,
        lineNumber: callFrame.location.lineNumber,
        columnNumber: callFrame.location.columnNumber,
        source: thread.scripts().get(callFrame.location.scriptId)
      });
      const stackFrame: DebugProtocol.StackFrame = {
        id: ++stackId,
        name: callFrame.functionName || '<anonymous>',
        line: location.lineNumber + 1,
        column: location.columnNumber + 1,
        source: this._sourceToDap(location.source),
        presentationHint: 'normal'
      };
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
        const location = this._sourceContainer.uiLocation({
          url: callFrame.url,
          lineNumber: callFrame.lineNumber,
          columnNumber: callFrame.columnNumber,
          source: thread.scripts().get(callFrame.scriptId)
        });
        const stackFrame: DebugProtocol.StackFrame = {
          id: ++stackId,
          name: callFrame.functionName || '<anonymous>',
          line: location.lineNumber + 1,
          column: location.columnNumber + 1,
          source: this._sourceToDap(location.source),
          presentationHint: 'normal'
        };
        result.push(stackFrame);
      }
      asyncParent = asyncParent.parent;
    }

    return {stackFrames: result, totalFrames: result.length};
  }

  _sourceToDap(source: Source | undefined): DebugProtocol.Source {
    if (!source)
      return {name: 'unknown'};

    let rebased: string | undefined;
    const url = source.url();
    if (url && url.startsWith('file://')) {
      rebased = url.substring(7);
      // TODO(dgozman): what if absolute file url does not belong to webRoot?
    } else if (url && this._launchParams && this._launchParams.webRoot) {
      try {
        let relative = new URL(url).pathname;
        if (relative === '' || relative === '/')
          relative = 'index.html';
        rebased = path.join(this._launchParams.webRoot, relative);
      } catch (e) {
      }
    }
    // TODO(dgozman): can we check whether the path exists? Search for another match? Provide source fallback?
    return {
      name: path.basename(rebased || source.url() || '') || '<anonymous>',
      path: rebased,
      sourceReference: rebased ? 0 : source.sourceReference(),
      presentationHint: 'normal'
    };
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
    const result = await completionz.completions(this._mainTarget.cdp(), params.text, params.line, params.column);
    return {
      targets: result.map(label => {
        return {label};
      })
    };
  }

  async getSources(params: DebugProtocol.LoadedSourcesArguments): Promise<DebugProtocol.Source[]> {
    return this._sourceContainer.sources().map(source => this._sourceToDap(source));
  }

  async getSourceContent(params: DebugProtocol.SourceArguments): Promise<DAP.GetSourceContentResult> {
    const source = this._sourceContainer.source(params.sourceReference);
    if (!source)
      return {content: '', mimeType: 'text/javascript'};
    return {content: await source.content(), mimeType: source.mimeType()};
  }

  async setBreakpoints(params: DebugProtocol.SetBreakpointsArguments): Promise<DebugProtocol.Breakpoint[]> {
    return [];
  }
}
