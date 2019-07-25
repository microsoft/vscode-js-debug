/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Dap from './dap/api';
import {Cdp, CdpApi} from './cdp/api';

import CdpConnection from './cdp/connection';
import {Target, TargetManager, TargetEvents} from './sdk/targetManager';
import findChrome from './chrome/findChrome';
import * as launcher from './chrome/launcher';
import * as completionz from './sdk/completions';
import {Thread, ThreadEvents} from './sdk/thread';
import {VariableStore} from './sdk/variableStore';
import * as objectPreview from './sdk/objectPreview';
import {Source, SourceContainer, Location} from './sdk/source';
import {StackTrace, StackFrame} from './sdk/stackTrace';

export interface LaunchParams extends Dap.LaunchParams {
  url: string;
  webRoot?: string;
}

export class Adapter {
  private _dap: Dap.Api;
  private _browser: CdpApi;
  private _sourceContainer: SourceContainer;
  private _targetManager: TargetManager;
  private _launchParams: LaunchParams;

  private _mainTarget: Target;
  private _threads: Map<number, Thread> = new Map();
  private _variableStore: VariableStore;

  constructor(dap: Dap.Api) {
    this._dap = dap;
    this._dap.on('initialize', params => this._onInitialize(params));
    this._dap.on('configurationDone', params => this._onConfigurationDone(params));
    this._dap.on('launch', params => this._onLaunch(params as LaunchParams));
    this._dap.on('terminate', params => this._onTerminate(params));
    this._dap.on('disconnect', params => this._onDisconnect(params));
    this._dap.on('restart', params => this._onRestart(params));
    this._dap.on('threads', params => this._onThreads(params));
    this._dap.on('continue', params => this._onContinue(params));
    this._dap.on('stackTrace', params => this._onStackTrace(params));
    this._dap.on('scopes', params => this._onScopes(params));
    this._dap.on('variables', params => this._onVariables(params));
    this._dap.on('evaluate', params => this._onEvaluate(params));
    this._dap.on('completions', params => this._onCompletions(params));
    this._dap.on('loadedSources', params => this._onLoadedSources(params));
    this._dap.on('source', params => this._onSource(params));
    this._dap.on('setBreakpoints', params => this._onSetBreakpoints(params));
  }

  async _onInitialize(params: Dap.InitializeParams): Promise<Dap.InitializeResult> {
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
    this._variableStore = new VariableStore(this._sourceContainer);
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

    connection.on(CdpConnection.Events.Disconnected, () => this._dap.exited({exitCode: 0}));

    // params.locale || 'en-US'
    // params.supportsVariableType
    // params.supportsVariablePaging
    // params.supportsRunInTerminalRequest
    // params.supportsMemoryReferences

    this._dap.initialized({});
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
      supportsDelayedStackTraceLoading: true,
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

  async _onConfigurationDone(params: Dap.ConfigurationDoneParams): Promise<Dap.ConfigurationDoneResult> {
    this._mainTarget = this._targetManager.mainTarget();
    if (!this._mainTarget)
      this._mainTarget = await new Promise(f => this._targetManager.once(TargetEvents.TargetAttached, f)) as Target;
    this._targetManager.on(TargetEvents.TargetDetached, (target: Target) => {
      if (target === this._mainTarget) {
        this._dap.terminated({});
      }
    });

    const onSource = (source: Source) => {
      this._dap.loadedSource({reason: 'new', source: source.toDap()});
    };
    this._sourceContainer.on(SourceContainer.Events.SourceAdded, onSource);
    this._sourceContainer.sources().forEach(onSource);
    this._sourceContainer.on(SourceContainer.Events.SourcesRemoved, (sources: Source[]) => {
      for (const source of sources)
        this._dap.loadedSource({reason: 'removed', source: source.toDap()});
    });
    return {};
  }

  _onThreadCreated(thread: Thread): void {
    console.assert(!this._threads.has(thread.threadId()));
    this._threads.set(thread.threadId(), thread);
    this._dap.thread({reason: 'started', threadId: thread.threadId()});

    const onPaused = () => {
      const details = thread.pausedDetails();
      this._dap.stopped({
        reason: details.reason,
        description: details.description,
        threadId: thread.threadId(),
        text: details.text,
        allThreadsStopped: false
      });
    };
    thread.on(ThreadEvents.ThreadPaused, onPaused);
    if (thread.pausedDetails())
      onPaused();

    thread.on(ThreadEvents.ThreadResumed, () => {
      this._dap.continued({threadId: thread.threadId()});
    });
    thread.on(ThreadEvents.ThreadConsoleMessage, ({thread, event}) => this._onConsoleMessage(thread, event));
  }

  _onThreadDestroyed(thread: Thread): void {
    this._threads.delete(thread.threadId());
    this._dap.thread({reason: 'exited', threadId: thread.threadId()});
  }

  async _onConsoleMessage(thread: Thread, event: Cdp.Runtime.ConsoleAPICalledEvent): Promise<void> {
    let stackTrace: StackTrace | undefined;
    let uiLocation: Location | undefined;
    if (event.stackTrace) {
      stackTrace = StackTrace.fromRuntime(thread, event.stackTrace);
      const frames = await stackTrace.loadFrames(1);
      if (frames.length)
        uiLocation = this._sourceContainer.uiLocation(frames[0].location);
      if (event.type !== 'error' && event.type !== 'warning')
        stackTrace = undefined;
    }

    let category = 'stdout';
    if (event.type === 'error')
      category = 'stderr';
    if (event.type === 'warning')
      category = 'console';

    const tokens = [];
    for (const arg of event.args)
      tokens.push(objectPreview.renderValue(arg, false));
    const messageText = tokens.join(' ');

    const allPrimitive = !event.args.find(a => a.objectId);
    if (allPrimitive && !stackTrace) {
      this._dap.output({
        category: category as any,
        output: messageText,
        variablesReference: 0,
        line: uiLocation ? uiLocation.lineNumber : undefined,
        column: uiLocation ? uiLocation.columnNumber : undefined,
      });
      return;
    }

    this._dap.output({
      category: category as any,
      output: '',
      variablesReference: await this._variableStore.createVariableForMessageFormat(thread.cdp(), messageText, event.args, stackTrace),
      line: uiLocation ? uiLocation.lineNumber : undefined,
      column: uiLocation ? uiLocation.columnNumber : undefined,
    });
  }

  async _onLaunch(params: LaunchParams): Promise<Dap.LaunchResult> {
    if (!this._mainTarget)
      await this._onConfigurationDone({});

    // params.noDebug
    this._launchParams = params;
    this._sourceContainer.setWebRoot(this._launchParams.webRoot);
    this._mainTarget.cdp().Page.navigate({url: this._launchParams.url});
    return {};
  }

  async _onTerminate(params: Dap.TerminateParams): Promise<Dap.TerminateResult> {
    this._mainTarget.cdp().Page.navigate({url: 'about:blank'});
    return {};
  }

  async _onDisconnect(params: Dap.DisconnectParams): Promise<Dap.DisconnectResult> {
    this._browser.Browser.close();
    return {};
  }

  async _onRestart(params: Dap.RestartParams): Promise<Dap.RestartResult> {
    this._mainTarget.cdp().Page.navigate({url: this._launchParams.url});
    return {};
  }

  async _onThreads(params: Dap.ThreadsParams): Promise<Dap.ThreadsResult> {
    const threads = [];
    for (const thread of this._threads.values())
      threads.push({id: thread.threadId(), name: thread.threadName()});
    return {threads};
  }

  async _onContinue(params: Dap.ContinueParams): Promise<Dap.ContinueResult> {
    const thread = this._threads.get(params.threadId);
    if (thread)
      thread.resume();
    return {allThreadsContinued: false};
  }

  async _onStackTrace(params: Dap.StackTraceParams): Promise<Dap.StackTraceResult> {
    const dummy = {stackFrames: [], totalFrames: 0};

    const thread = this._threads.get(params.threadId);
    if (!thread)
      return dummy;
    const details = thread.pausedDetails();
    if (!details)
      return dummy;

    const from = params.startFrame || 0;
    const to = params.levels ? from + params.levels : from + 1;
    const frames = await details.stackTrace.loadFrames(to);
    // TODO(dgozman): figure out whether we should always check for current in
    // every async function or it will work out by itself because UI is smart.
    if (thread.pausedDetails() !== details)
      return dummy;

    const result: Dap.StackFrame[] = [];
    for (let index = from; index < to && index < frames.length; index++) {
      const stackFrame = frames[index];
      const uiLocation = this._sourceContainer.uiLocation(stackFrame.location);
      result.push({
        id: stackFrame.id,
        name: stackFrame.name,
        line: uiLocation.lineNumber + 1,
        column: uiLocation.columnNumber + 1,
        source: uiLocation.source ? uiLocation.source.toDap() : undefined,
        presentationHint: stackFrame.isAsyncSeparator ? 'label' : 'normal'
      });
    }
    return {stackFrames: result, totalFrames: details.stackTrace.canLoadMoreFrames() ? 1000000 : frames.length};
  }

  async _onScopes(params: Dap.ScopesParams): Promise<Dap.ScopesResult> {
    let stackFrame: StackFrame | undefined;
    let frameThread: Thread | undefined;
    for (const thread of this._threads.values()) {
      if (!thread.pausedDetails())
        continue;
      stackFrame = thread.pausedDetails().stackTrace.frame(params.frameId);
      frameThread = thread;
      if (stackFrame)
        break;
    }
    if (!stackFrame || !stackFrame.scopeChain)
      return {scopes: []};
    const scopes: Dap.Scope[] = [];
    for (const scope of stackFrame.scopeChain) {
      let name: string = '';
      let presentationHint: 'arguments' | 'locals' | 'registers' | undefined;
      switch (scope.type) {
        case 'global':
          name = 'Global';
          break;
        case 'local':
          name = 'Local';
          presentationHint = 'locals';
          break;
        case 'with':
          name = 'With Block';
          presentationHint = 'locals';
          break;
        case 'closure':
          name = 'Closure';
          presentationHint = 'arguments';
          break;
        case 'catch':
          name = 'Catch Block';
          presentationHint = 'locals';
          break;
        case 'block':
          name = 'Block';
          presentationHint = 'locals';
          break;
        case 'script':
          name = 'Script';
          break;
        case 'eval':
          name = 'Eval';
          break;
        case 'module':
          name = 'Module';
          break;
      }
      const variable = await this._variableStore.createVariable(frameThread.cdp(), scope.object);
      const uiStartLocation = scope.startLocation
          ? this._sourceContainer.uiLocation(frameThread.locationFromDebugger(scope.startLocation))
          : undefined;
      const uiEndLocation = scope.endLocation
          ? this._sourceContainer.uiLocation(frameThread.locationFromDebugger(scope.endLocation))
          : undefined;
      if (scope.name && scope.type === 'closure')
        name = `Closure ${scope.name}`;
      else if (scope.name)
        name = scope.name;
      scopes.push({
        name,
        presentationHint,
        expensive: scope.type === 'global',
        namedVariables: variable.namedVariables,
        indexedVariables: variable.indexedVariables,
        variablesReference: variable.variablesReference,
        source: uiStartLocation && uiStartLocation.source ? uiStartLocation.source.toDap() : undefined,
        line: uiStartLocation ? uiStartLocation.lineNumber + 1 : undefined,
        column: uiStartLocation ? uiStartLocation.columnNumber + 1 : undefined,
        endLine: uiEndLocation ? uiEndLocation.lineNumber + 1 : undefined,
        endColumn: uiEndLocation ? uiEndLocation.columnNumber + 1 : undefined,
      });
    }
    return {scopes};
  }

  async _onVariables(params: Dap.VariablesParams): Promise<Dap.VariablesResult> {
    return {variables: await this._variableStore.getVariables(params)};
  }

  async _onEvaluate(args: Dap.EvaluateParams): Promise<Dap.EvaluateResult> {
    if (!this._mainTarget)
      return {result: '', variablesReference: 0};
    const response = await this._mainTarget.cdp().Runtime.evaluate({
      expression: args.expression,
      includeCommandLineAPI: true,
      objectGroup: 'console',
      generatePreview: true
    });
    const variable = await this._variableStore.createVariable(this._mainTarget.cdp(), response.result, args.context);
    const prefix = args.context === 'repl' ? '↳ ' : '';
    return {
      result: prefix + variable.value,
      variablesReference: variable.variablesReference,
      namedVariables: variable.namedVariables,
      indexedVariables: variable.indexedVariables,
    };
  }

  async _onCompletions(params: Dap.CompletionsParams): Promise<Dap.CompletionsResult> {
    if (!this._mainTarget)
      return {targets: []};
    return {targets: await completionz.completions(this._mainTarget.cdp(), params.text, params.line, params.column)};
  }

  async _onLoadedSources(params: Dap.LoadedSourcesParams): Promise<Dap.LoadedSourcesResult> {
    return {sources: this._sourceContainer.sources().map(source => source.toDap())};
  }

  async _onSource(params: Dap.SourceParams): Promise<Dap.SourceResult> {
    const source = this._sourceContainer.source(params.sourceReference);
    if (!source)
      return {content: '', mimeType: 'text/javascript'};
    return {content: await source.content(), mimeType: source.mimeType()};
  }

  async _onSetBreakpoints(params: Dap.SetBreakpointsParams): Promise<Dap.SetBreakpointsResult> {
    return {breakpoints: []};
  }
}
