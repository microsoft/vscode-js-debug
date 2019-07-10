// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Dap from '../dap/api';

import CdpConnection from '../cdp/connection';
import {Target, TargetManager, ExecutionContext} from './targetManager';
import findChrome from '../chrome/findChrome';
import * as launcher from '../chrome/launcher';
import * as completionz from './completions';
import {StackTrace} from './stackTrace';
import * as objectPreview from './objectPreview';
import Cdp from '../cdp/api';
import {VariableStore, ScopeRef} from './variableStore';
import {SourceContainer, LaunchParams, SourcePathResolver} from './source';
import * as path from 'path';
import * as fs from 'fs';
import * as nls from 'vscode-nls';
import * as errors from './errors';

const localize = nls.loadMessageBundle();

export interface ConfigurationDoneResult extends Dap.ConfigurationDoneResult {
  targetId?: string;
}

export class Adapter {
  private _dap: Dap.Api;
  private _connection: CdpConnection;
  private _storagePath: string;
  private _initializeParams: Dap.InitializeParams;
  private _targetManager: TargetManager;
  private _launchParams: LaunchParams;
  private _sourcePathResolver: SourcePathResolver;
  private _sourceContainer: SourceContainer;
  private _mainTarget?: Target;
  private _exceptionEvaluateName: string;
  private _currentExecutionContext: ExecutionContext | undefined;

  constructor(dap: Dap.Api, storagePath: string) {
    this._dap = dap;
    this._storagePath = storagePath;
    this._dap.on('initialize', params => this._onInitialize(params));
    this._dap.on('configurationDone', params => this._onConfigurationDone(params));
    this._dap.on('launch', params => this._onLaunch(params as LaunchParams));
    this._dap.on('terminate', params => this._onTerminate(params));
    this._dap.on('disconnect', params => this._onDisconnect(params));
    this._dap.on('restart', params => this._onRestart(params));
    this._dap.on('threads', params => this._onThreads(params));
    this._dap.on('continue', params => this._onContinue(params));
    this._dap.on('pause', params => this._onPause(params));
    this._dap.on('next', params => this._onNext(params));
    this._dap.on('stepIn', params => this._onStepIn(params));
    this._dap.on('stepOut', params => this._onStepOut(params));
    this._dap.on('restartFrame', params => this._onRestartFrame(params));
    this._dap.on('stackTrace', params => this._onStackTrace(params));
    this._dap.on('scopes', params => this._onScopes(params));
    this._dap.on('variables', params => this._onVariables(params));
    this._dap.on('evaluate', params => this._onEvaluate(params));
    this._dap.on('completions', params => this._onCompletions(params));
    this._dap.on('loadedSources', params => this._onLoadedSources(params));
    this._dap.on('source', params => this._onSource(params));
    this._dap.on('setBreakpoints', params => this._onSetBreakpoints(params));
    this._dap.on('setExceptionBreakpoints', params => this._onSetExceptionBreakpoints(params));
    this._dap.on('exceptionInfo', params => this._onExceptionInfo(params));
    this._dap.on('updateCustomBreakpoints', params => this.onUpdateCustomBreakpoints(params));
    this._dap.on('setVariable', params => this._onSetVariable(params));
    this._dap.on('toggleSourceBlackboxed', params => this._onToggleSourceBlackboxed(params));
    this._exceptionEvaluateName = '-$-$cdp-exception$-$-';
  }

  testConnection(): Promise<CdpConnection> {
    return this._connection.clone();
  }

  targetManager(): TargetManager {
    return this._targetManager;
  }

  _isUnderTest(): boolean {
    return this._initializeParams.clientID === 'cdp-test';
  }

  async _onInitialize(params: Dap.InitializeParams): Promise<Dap.InitializeResult | Dap.Error> {
    this._initializeParams = params;
    console.assert(params.linesStartAt1);
    console.assert(params.columnsStartAt1);
    console.assert(params.pathFormat === 'path');

    const executablePath = findChrome().pop();
    if (!executablePath)
      return errors.createUserError(localize('error.executableNotFound', 'Unable to find Chrome'));
    const args: string[] = [];
    if (this._isUnderTest()) {
      args.push('--remote-debugging-port=0');
      args.push('--headless');
    }

    try {
      fs.mkdirSync(this._storagePath);
    } catch (e) {
    }
    this._connection = await launcher.launch(
      executablePath, {
        args,
        userDataDir: path.join(this._storagePath, this._isUnderTest() ? '.headless-profile' : 'profile'),
        pipe: true,
      });
    this._connection.on(CdpConnection.Events.Disconnected, () => this._dap.exited({exitCode: 0}));

    this._sourcePathResolver = new SourcePathResolver();
    this._sourceContainer = new SourceContainer(this._dap, this._sourcePathResolver);
    this._targetManager = new TargetManager(this._connection, this._dap, this._sourceContainer);

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
      exceptionBreakpointFilters: [
        {filter: 'caught', label: localize('breakpoint.caughtExceptions', 'Caught Exceptions'), default: false},
        {filter: 'uncaught', label: localize('breakpoint.uncaughtExceptions', 'Uncaught Exceptions'), default: false},
      ],
      supportsStepBack: false,
      supportsSetVariable: true,
      supportsRestartFrame: true,
      supportsGotoTargetsRequest: false,
      supportsStepInTargetsRequest: false,
      supportsCompletionsRequest: true,
      supportsModulesRequest: false,
      additionalModuleColumns: [],
      supportedChecksumAlgorithms: [],
      supportsRestartRequest: true,
      supportsExceptionOptions: false,
      supportsValueFormattingOptions: false,
      supportsExceptionInfoRequest: true,
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

  async _onConfigurationDone(params: Dap.ConfigurationDoneParams): Promise<ConfigurationDoneResult> {
    // TODO(dgozman): assuming first page is our main target breaks multiple debugging sessions
    // sharing the browser instance.
    this._mainTarget = this._targetManager.mainTarget();
    if (!this._mainTarget)
      this._mainTarget = await new Promise(f => this._targetManager.onTargetAdded(f)) as Target;
    this._targetManager.onTargetRemoved((target: Target) => {
      if (target === this._mainTarget) {
        this._dap.terminated({});
      }
    });
    if (this._isUnderTest())
      return {targetId: this._mainTarget.targetId()};
    return {};
  }

  async _onLaunch(params: LaunchParams): Promise<Dap.LaunchResult> {
    if (!this._mainTarget)
      await this._onConfigurationDone({});

    // params.noDebug
    this._launchParams = params;
    this._sourcePathResolver.initialize(params.webRoot);
    this._sourceContainer.initialize();
    await this._mainTarget!.cdp().Page.navigate({url: params.url});
    return {};
  }

  _mainTargetNotAvailable(): Dap.Error {
    return errors.createSilentError('Page is not available');
  }

  async _onTerminate(params: Dap.TerminateParams): Promise<Dap.TerminateResult | Dap.Error> {
    if (!this._mainTarget)
      return this._mainTargetNotAvailable();
    this._mainTarget.cdp().Page.navigate({url: 'about:blank'});
    return {};
  }

  async _onDisconnect(params: Dap.DisconnectParams): Promise<Dap.DisconnectResult | Dap.Error> {
    if (!this._targetManager)
      return this._mainTargetNotAvailable();
    await this._connection.browser().Browser.close({});
    return {};
  }

  async _onRestart(params: Dap.RestartParams): Promise<Dap.RestartResult | Dap.Error> {
    if (!this._mainTarget)
      return this._mainTargetNotAvailable();
    await this._mainTarget.cdp().Page.navigate({url: this._launchParams.url});
    return {};
  }

  async _onThreads(params: Dap.ThreadsParams): Promise<Dap.ThreadsResult | Dap.Error> {
    const threads: Dap.Thread[] = [];
    for (const thread of this._targetManager.threads.values())
      threads.push({id: thread.threadId(), name: thread.threadNameWithIndentation()});
    return {threads};
  }

  async _onContinue(params: Dap.ContinueParams): Promise<Dap.ContinueResult | Dap.Error> {
    const thread = this._targetManager.threads.get(params.threadId);
    if (!thread)
      return errors.createSilentError(localize('error.threadNotFound', 'Thread not found'));
    if (!await thread.resume())
      return errors.createSilentError(localize('error.resumeDidFail', 'Unable to resume'));
    return {allThreadsContinued: false};
  }

  async _onPause(params: Dap.PauseParams): Promise<Dap.PauseResult | Dap.Error> {
    const thread = this._targetManager.threads.get(params.threadId);
    if (!thread)
      return errors.createSilentError(localize('error.threadNotFound', 'Thread not found'));
    if (!await thread.pause())
      return errors.createSilentError(localize('error.pauseDidFail', 'Unable to pause'));
    return {};
  }

  async _onNext(params: Dap.NextParams): Promise<Dap.NextResult | Dap.Error> {
    const thread = this._targetManager.threads.get(params.threadId);
    if (!thread)
      return errors.createSilentError(localize('error.threadNotFound', 'Thread not found'));
    if (!await thread.stepOver())
      return errors.createSilentError(localize('error.stepOverDidFail', 'Unable to step next'));
    return {};
  }

  async _onStepIn(params: Dap.StepInParams): Promise<Dap.StepInResult | Dap.Error> {
    const thread = this._targetManager.threads.get(params.threadId);
    if (!thread)
      return errors.createSilentError(localize('error.threadNotFound', 'Thread not found'));
    // TODO(dgozman): support |params.targetId|.
    if (!await thread.stepInto())
      return errors.createSilentError(localize('error.stepInDidFail', 'Unable to step in'));
    return {};
  }

  async _onStepOut(params: Dap.StepOutParams): Promise<Dap.StepOutResult | Dap.Error> {
    const thread = this._targetManager.threads.get(params.threadId);
    if (!thread)
      return errors.createSilentError(localize('error.threadNotFound', 'Thread not found'));
    if (!await thread.stepOut())
      return errors.createSilentError(localize('error.stepOutDidFail', 'Unable to step out'));
    return {};
  }

  async _onRestartFrame(params: Dap.RestartFrameParams): Promise<Dap.RestartFrameResult | Dap.Error> {
    const stackTrace = this._findStackTrace(params.frameId);
    if (!stackTrace)
      return errors.createSilentError(localize('error.stackFrameNotFound', 'Stack frame not found'));
    const callFrameId = stackTrace.frame(params.frameId)!.callFrameId;
    if (!callFrameId)
      return errors.createUserError(localize('error.restartFrameAsync', 'Cannot restart asynchronous frame'));
    if (!await stackTrace.thread().restartFrame(callFrameId))
      return errors.createSilentError(localize('error.restartFrameDidFail', 'Unable to restart frame'));
    return {};
  }

  async _onStackTrace(params: Dap.StackTraceParams): Promise<Dap.StackTraceResult | Dap.Error> {
    const thread = this._targetManager.threads.get(params.threadId);
    if (!thread)
      return errors.createSilentError(localize('error.threadNotFound', 'Thread not found'));
    const details = thread.pausedDetails();
    if (!details)
      return errors.createSilentError(localize('error.threadNotPaused', 'Thread is not paused'));

    const from = params.startFrame || 0;
    let to = params.levels ? from + params.levels : from + 1;
    const frames = await details.stackTrace.loadFrames(to);
    to = Math.min(frames.length, params.levels ? to : frames.length);
    const result: Dap.StackFrame[] = [];
    for (let index = from; index < to; index++) {
      const stackFrame = frames[index];
      const uiLocation = this._sourceContainer.uiLocation(stackFrame.location);
      result.push({
        id: stackFrame.id,
        name: stackFrame.name,
        line: uiLocation.lineNumber,
        column: uiLocation.columnNumber,
        source: uiLocation.source ? uiLocation.source.toDap() : undefined,
        presentationHint: stackFrame.isAsyncSeparator ? 'label' : 'normal'
      });
    }
    return {stackFrames: result, totalFrames: details.stackTrace.canLoadMoreFrames() ? 1000000 : frames.length};
  }

  _findStackTrace(frameId: number): StackTrace | undefined {
    for (const thread of this._targetManager.threads.values()) {
      const details = thread.pausedDetails();
      if (details && details.stackTrace.frame(frameId))
        return details.stackTrace;
    }
    return undefined;
  }

  async _onScopes(params: Dap.ScopesParams): Promise<Dap.ScopesResult | Dap.Error> {
    const stackTrace = this._findStackTrace(params.frameId);
    if (!stackTrace)
      return errors.createSilentError(localize('error.stackFrameNotFound', 'Stack frame not found'));
    const stackFrame = stackTrace.frame(params.frameId)!;
    const thread = stackTrace.thread();
    if (!stackFrame.scopeChain)
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
      const scopeRef: ScopeRef = {callFrameId: stackFrame.callFrameId!, scopeNumber: index};
      const variable = await thread.pausedVariables()!.createScope(scope.object, scopeRef);
      const uiStartLocation = scope.startLocation
        ? this._sourceContainer.uiLocation(thread.locationFromDebugger(scope.startLocation))
        : undefined;
      const uiEndLocation = scope.endLocation
        ? this._sourceContainer.uiLocation(thread.locationFromDebugger(scope.endLocation))
        : undefined;
      if (scope.name && scope.type === 'closure') {
        name = localize('scope.closureNamed', 'Closure ({0})', scope.name);
      } else if (scope.name) {
        name = scope.name;
      }
      scopes.push({
        name,
        presentationHint,
        expensive: scope.type === 'global',
        namedVariables: variable.namedVariables,
        indexedVariables: variable.indexedVariables,
        variablesReference: variable.variablesReference,
        source: uiStartLocation && uiStartLocation.source ? uiStartLocation.source.toDap() : undefined,
        line: uiStartLocation ? uiStartLocation.lineNumber : undefined,
        column: uiStartLocation ? uiStartLocation.columnNumber : undefined,
        endLine: uiEndLocation ? uiEndLocation.lineNumber : undefined,
        endColumn: uiEndLocation ? uiEndLocation.columnNumber : undefined,
      });
    }
    return {scopes};
  }

  _findVariableStore(variablesReference: number): VariableStore | null {
    for (const target of this._targetManager.targets()) {
      const thread = target.thread()
      if (!thread)
        continue;
      if (thread.pausedVariables() && thread.pausedVariables()!.hasVariables(variablesReference))
        return thread.pausedVariables();
      if (thread.replVariables.hasVariables(variablesReference))
        return thread.replVariables;
    }
    return null;
  }

  async _onVariables(params: Dap.VariablesParams): Promise<Dap.VariablesResult> {
    let variableStore = this._findVariableStore(params.variablesReference);
    if (!variableStore)
      return {variables: []};
    return {variables: await variableStore.getVariables(params)};
  }

  _targetForThreadId(threadId: number): Target | null {
    for (const target of this._targetManager.targets()) {
      if (target.thread() && target.thread()!.threadId() === threadId)
        return target;
    }
    return null;
  }

  async _onEvaluate(args: Dap.EvaluateParams): Promise<Dap.EvaluateResult | Dap.Error> {
    if (!this._mainTarget)
      return this._mainTargetNotAvailable();
    if (args.frameId !== undefined) {
      const stackTrace = this._findStackTrace(args.frameId);
      if (!stackTrace)
        return errors.createSilentError(localize('error.stackFrameNotFound', 'Stack frame not found'));
      const exception = stackTrace.thread().pausedDetails()!.exception;
      if (exception && args.expression === this._exceptionEvaluateName)
        return this._evaluateResult(stackTrace.thread().pausedVariables()!, exception);
    }
    let target = this._currentExecutionContext ? this._targetForThreadId(this._currentExecutionContext.threadId) : null;
    if (!target)
      target = this._mainTarget;

    const response = await target.cdp().Runtime.evaluate({
      expression: args.expression,
      contextId: this._currentExecutionContext ? this._currentExecutionContext.contextId : undefined,
      includeCommandLineAPI: true,
      objectGroup: 'console',
      generatePreview: true
    });

    if (!response)
      return errors.createSilentError(localize('error.evaluateDidFail', 'Unable to evaluate'));
    return this._evaluateResult(target.thread()!.replVariables, response.result, args.context);
  }

  async _evaluateResult(variableStore: VariableStore, result: Cdp.Runtime.RemoteObject, context?: 'watch' | 'repl' | 'hover'): Promise<Dap.EvaluateResult> {
    const variable = await variableStore.createVariable(result, context);
    const prefix = context === 'repl' ? '↳ ' : '';
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
    const line = params.line === undefined ? 0 : params.line - 1;
    return {targets: await completionz.completions(this._mainTarget.cdp(), params.text, line, params.column)};
  }

  async _onLoadedSources(params: Dap.LoadedSourcesParams): Promise<Dap.LoadedSourcesResult> {
    return {sources: this._sourceContainer.sources().map(source => source.toDap())};
  }

  async _onSource(params: Dap.SourceParams): Promise<Dap.SourceResult | Dap.Error> {
    const source = this._sourceContainer.source(params.source!);
    if (!source)
      return errors.createSilentError(localize('error.sourceNotFound', 'Source not found'));
    const content = await source.content();
    if (content === undefined)
      return errors.createSilentError(localize('error.sourceContentDidFail', 'Unable to retrieve source content'));
    return {content, mimeType: source.mimeType()};
  }

  async _onSetBreakpoints(params: Dap.SetBreakpointsParams): Promise<Dap.SetBreakpointsResult> {
    return {breakpoints: []};
  }

  async _onSetExceptionBreakpoints(params: Dap.SetExceptionBreakpointsParams): Promise<Dap.SetExceptionBreakpointsResult> {
    if (params.filters.includes('caught'))
      this._targetManager.setPauseOnExceptionsState('all');
    else if (params.filters.includes('uncaught'))
      this._targetManager.setPauseOnExceptionsState('uncaught');
    else
      this._targetManager.setPauseOnExceptionsState('none');
    return {};
  }

  async _onExceptionInfo(params: Dap.ExceptionInfoParams): Promise<Dap.ExceptionInfoResult | Dap.Error> {
    const thread = this._targetManager.threads.get(params.threadId);
    if (!thread)
      return errors.createSilentError(localize('error.threadNotFound', 'Thread not found'));
    const details = thread.pausedDetails();
    const exception = details && details.exception;
    if (!exception)
      return errors.createSilentError(localize('error.threadNotPausedOnException', 'Thread is not paused on exception'));
    const preview = objectPreview.previewException(exception);
    return {
      exceptionId: preview.title,
      breakMode: this._targetManager.pauseOnExceptionsState() === 'all' ? 'always' : 'unhandled',
      details: {
        stackTrace: preview.stackTrace,
        // TODO(dgozman): |evaluateName| is not used by VSCode yet. Remove?
        evaluateName: this._exceptionEvaluateName,
      }
    };
  }

  async onUpdateCustomBreakpoints(params: Dap.UpdateCustomBreakpointsParams): Promise<Dap.UpdateCustomBreakpointsResult> {
    await this._targetManager.updateCustomBreakpoints(params.breakpoints);
    return {};
  }

  async _onSetVariable(params: Dap.SetVariableParams): Promise<Dap.SetVariableResult | Dap.Error> {
    let variableStore = this._findVariableStore(params.variablesReference);
    if (!variableStore)
      return errors.createSilentError(localize('error.variableNotFound', 'Variable not found'));
    return variableStore.setVariable(params);
  }

  async _onToggleSourceBlackboxed(params: Dap.ToggleSourceBlackboxedParams): Promise<Dap.ToggleSourceBlackboxedResult | Dap.Error> {
    this._sourceContainer.toggleSourceBlackboxed(params.source);
    return {};
  }

  setCurrentExecutionContext(item: ExecutionContext | undefined) {
    this._currentExecutionContext = item;
  }
}
