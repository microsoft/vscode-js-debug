// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Dap from '../dap/api';

import CdpConnection from '../cdp/connection';
import { ExecutionContext } from './threadManager';
import * as completionz from './completions';
import { StackTrace } from './stackTrace';
import * as objectPreview from './objectPreview';
import Cdp from '../cdp/api';
import { VariableStore, ScopeRef } from './variableStore';
import { SourceContainer, SourcePathResolver } from './source';
import * as nls from 'vscode-nls';
import * as errors from './errors';
import { BreakpointManager } from './breakpoints';
import { ThreadManager } from './threadManager';

const localize = nls.loadMessageBundle();

export interface ConfigurationDoneResult extends Dap.ConfigurationDoneResult {
  targetId?: string;
}

export class Adapter {
  private _dap: Dap.Api;
  private _connection: CdpConnection;
  readonly threadManager: ThreadManager;
  private _sourcePathResolver: SourcePathResolver;
  private _breakpointManager: BreakpointManager;
  private _sourceContainer: SourceContainer;
  private _exceptionEvaluateName: string;
  private _currentExecutionContext: ExecutionContext | undefined;

  constructor(dap: Dap.Api, connection: CdpConnection, executionContextProvider: () => ExecutionContext[]) {
    this._dap = dap;
    this._connection = connection;
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
    this._exceptionEvaluateName = '-$-$cdp-exception$-$-';

    this._sourcePathResolver = new SourcePathResolver();
    this._sourceContainer = new SourceContainer(this._dap, this._sourcePathResolver);
    this.threadManager = new ThreadManager(this._dap, this._sourceContainer, executionContextProvider);
    this._breakpointManager = new BreakpointManager(this._dap, this._sourcePathResolver, this._sourceContainer, this.threadManager);
  }

  testConnection(): Promise<CdpConnection> {
    return this._connection.clone();
  }

  async initialize(params: Dap.InitializeParams): Promise<Dap.InitializeResult | Dap.Error> {
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

  async launch(url: string, webRoot: string | undefined): Promise<Dap.LaunchResult> {
    this._sourcePathResolver.initialize(url, webRoot);
    this._sourceContainer.initialize();
    this._breakpointManager.initialize();
    return {};
  }

  _mainThreadNotAvailable(): Dap.Error {
    return errors.createSilentError('Page is not available');
  }

  async _onThreads(params: Dap.ThreadsParams): Promise<Dap.ThreadsResult | Dap.Error> {
    const threads: Dap.Thread[] = [];
    for (const thread of this.threadManager.threads())
      threads.push({id: thread.threadId(), name: thread.threadNameWithIndentation()});
    return {threads};
  }

  async _onContinue(params: Dap.ContinueParams): Promise<Dap.ContinueResult | Dap.Error> {
    const thread = this.threadManager.thread(params.threadId);
    if (!thread)
      return errors.createSilentError(localize('error.threadNotFound', 'Thread not found'));
    if (!await thread.resume())
      return errors.createSilentError(localize('error.resumeDidFail', 'Unable to resume'));
    return {allThreadsContinued: false};
  }

  async _onPause(params: Dap.PauseParams): Promise<Dap.PauseResult | Dap.Error> {
    const thread = this.threadManager.thread(params.threadId);
    if (!thread)
      return errors.createSilentError(localize('error.threadNotFound', 'Thread not found'));
    if (!await thread.pause())
      return errors.createSilentError(localize('error.pauseDidFail', 'Unable to pause'));
    return {};
  }

  async _onNext(params: Dap.NextParams): Promise<Dap.NextResult | Dap.Error> {
    const thread = this.threadManager.thread(params.threadId);
    if (!thread)
      return errors.createSilentError(localize('error.threadNotFound', 'Thread not found'));
    if (!await thread.stepOver())
      return errors.createSilentError(localize('error.stepOverDidFail', 'Unable to step next'));
    return {};
  }

  async _onStepIn(params: Dap.StepInParams): Promise<Dap.StepInResult | Dap.Error> {
    const thread = this.threadManager.thread(params.threadId);
    if (!thread)
      return errors.createSilentError(localize('error.threadNotFound', 'Thread not found'));
    // TODO(dgozman): support |params.targetId|.
    if (!await thread.stepInto())
      return errors.createSilentError(localize('error.stepInDidFail', 'Unable to step in'));
    return {};
  }

  async _onStepOut(params: Dap.StepOutParams): Promise<Dap.StepOutResult | Dap.Error> {
    const thread = this.threadManager.thread(params.threadId);
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
    const thread = this.threadManager.thread(params.threadId);
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
      const source = uiLocation.source ? uiLocation.source.toDap() : undefined;
      const presentationHint = stackFrame.isAsyncSeparator ? 'label' :
        (source && source.presentationHint === 'subtle' ? 'subtle' : 'normal');
      result.push({
        id: stackFrame.id,
        name: stackFrame.name,
        line: uiLocation.lineNumber,
        column: uiLocation.columnNumber,
        source,
        presentationHint,
      });
    }
    return {stackFrames: result, totalFrames: details.stackTrace.canLoadMoreFrames() ? 1000000 : frames.length};
  }

  _findStackTrace(frameId: number): StackTrace | undefined {
    for (const thread of this.threadManager.threads()) {
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
    for (const thread of this.threadManager.threads()) {
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

  async _onEvaluate(args: Dap.EvaluateParams): Promise<Dap.EvaluateResult | Dap.Error> {
    const mainThread = this.threadManager.mainThread();
    if (!mainThread)
      return this._mainThreadNotAvailable();
    if (args.frameId !== undefined) {
      const stackTrace = this._findStackTrace(args.frameId);
      if (!stackTrace)
        return errors.createSilentError(localize('error.stackFrameNotFound', 'Stack frame not found'));
      const exception = stackTrace.thread().pausedDetails()!.exception;
      if (exception && args.expression === this._exceptionEvaluateName)
        return this._evaluateResult(stackTrace.thread().pausedVariables()!, exception);
    }
    let thread = this._currentExecutionContext ? this.threadManager.thread(this._currentExecutionContext.threadId) : null;
    if (!thread)
      thread = mainThread;

    const response = await thread.cdp().Runtime.evaluate({
      expression: args.expression,
      contextId: this._currentExecutionContext ? this._currentExecutionContext.contextId : undefined,
      includeCommandLineAPI: true,
      objectGroup: 'console',
      generatePreview: true
    });

    if (!response)
      return errors.createSilentError(localize('error.evaluateDidFail', 'Unable to evaluate'));
    return this._evaluateResult(thread.replVariables, response.result, args.context);
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
    const mainThread = this.threadManager.mainThread();
    if (!mainThread)
      return {targets: []};
    const line = params.line === undefined ? 0 : params.line - 1;
    return {targets: await completionz.completions(mainThread.cdp(), params.text, line, params.column)};
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

  async _onSetBreakpoints(params: Dap.SetBreakpointsParams): Promise<Dap.SetBreakpointsResult | Dap.Error> {
    return this._breakpointManager.setBreakpoints(params);
  }

  async _onSetExceptionBreakpoints(params: Dap.SetExceptionBreakpointsParams): Promise<Dap.SetExceptionBreakpointsResult> {
    if (params.filters.includes('caught'))
      this.threadManager.setPauseOnExceptionsState('all');
    else if (params.filters.includes('uncaught'))
      this.threadManager.setPauseOnExceptionsState('uncaught');
    else
      this.threadManager.setPauseOnExceptionsState('none');
    return {};
  }

  async _onExceptionInfo(params: Dap.ExceptionInfoParams): Promise<Dap.ExceptionInfoResult | Dap.Error> {
    const thread = this.threadManager.thread(params.threadId);
    if (!thread)
      return errors.createSilentError(localize('error.threadNotFound', 'Thread not found'));
    const details = thread.pausedDetails();
    const exception = details && details.exception;
    if (!exception)
      return errors.createSilentError(localize('error.threadNotPausedOnException', 'Thread is not paused on exception'));
    const preview = objectPreview.previewException(exception);
    return {
      exceptionId: preview.title,
      breakMode: this.threadManager.pauseOnExceptionsState() === 'all' ? 'always' : 'unhandled',
      details: {
        stackTrace: preview.stackTrace,
        // TODO(dgozman): |evaluateName| is not used by VSCode yet. Remove?
        evaluateName: this._exceptionEvaluateName,
      }
    };
  }

  async onUpdateCustomBreakpoints(params: Dap.UpdateCustomBreakpointsParams): Promise<Dap.UpdateCustomBreakpointsResult> {
    await this.threadManager.updateCustomBreakpoints(params.breakpoints);
    return {};
  }

  async _onSetVariable(params: Dap.SetVariableParams): Promise<Dap.SetVariableResult | Dap.Error> {
    let variableStore = this._findVariableStore(params.variablesReference);
    if (!variableStore)
      return errors.createSilentError(localize('error.variableNotFound', 'Variable not found'));
    return variableStore.setVariable(params);
  }

  setCurrentExecutionContext(item: ExecutionContext | undefined) {
    this._currentExecutionContext = item;
  }
}
