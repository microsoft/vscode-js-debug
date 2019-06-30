// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Dap from '../dap/api';

import CdpConnection from '../cdp/connection';
import {Target, TargetEvents, TargetManager} from './targetManager';
import findChrome from '../chrome/findChrome';
import * as launcher from '../chrome/launcher';
import * as completionz from './completions';
import {Thread} from './thread';
import {StackFrame} from './stackTrace';
import * as objectPreview from './objectPreview';
import Cdp from '../cdp/api';
import { VariableStore } from './variableStore';
import { SourceContainer, LaunchParams } from './source';
import * as path from 'path';

export interface ConfigurationDoneResult extends Dap.ConfigurationDoneResult {
  targetId?: string;
}

export class Adapter {
  private _dap: Dap.Api;
  private _connection: CdpConnection;
  private _initializeParams: Dap.InitializeParams;
  private _targetManager: TargetManager;
  private _launchParams: LaunchParams;
  private _sourceContainer: SourceContainer;
  private _mainTarget?: Target;
  private _exceptionEvaluateName: string;

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
    this._dap.on('pause', params => this._onPause(params));
    this._dap.on('next', params => this._onNext(params));
    this._dap.on('stepIn', params => this._onStepIn(params));
    this._dap.on('stepOut', params => this._onStepOut(params));
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
    this._dap.on('updateCustomBreakpoints', params => this._onUpdateCustomBreakpoints(params));
    this._exceptionEvaluateName = '-$-$cdp-exception$-$-';
  }

  testConnection(): Promise<CdpConnection> {
    return this._connection.clone();
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
      return createUserError('Unable to find Chrome');
    const args: string[] = [];
    if (this._isUnderTest()) {
      args.push('--remote-debugging-port=0');
      args.push('--headless');
    }
    const userDataDir = '';
    this._connection = await launcher.launch(
      executablePath, {
        args,
        userDataDir: path.join(userDataDir, this._isUnderTest() ? '.cdp-headless-profile' : '.cdp-profile'),
        pipe: true,
      });
    this._connection.on(CdpConnection.Events.Disconnected, () => this._dap.exited({exitCode: 0}));

    this._sourceContainer = new SourceContainer(this._dap);
    this._targetManager = new TargetManager(this._connection, this._dap, this._sourceContainer);

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
      exceptionBreakpointFilters: [
        {filter: 'caught', label: 'Caught Exceptions', default: false},
        {filter: 'uncaught', label: 'Uncaught Exceptions', default: false},
      ],
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
    this._mainTarget = this._targetManager.mainTarget();
    if (!this._mainTarget)
      this._mainTarget = await new Promise(f => this._targetManager.once(TargetEvents.TargetAttached, f)) as Target;
    this._targetManager.on(TargetEvents.TargetDetached, (target: Target) => {
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
    this._sourceContainer.initialize(params.webRoot);
    await this._mainTarget!.cdp().Page.navigate({url: params.url});
    return {};
  }

  _mainTargetNotAvailable(): Dap.Error {
    return createSilentError('Page is not available');
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
      threads.push({id: thread.threadId(), name: thread.threadName()});
    return {threads};
  }

  async _onContinue(params: Dap.ContinueParams): Promise<Dap.ContinueResult | Dap.Error> {
    const thread = this._targetManager.threads.get(params.threadId);
    if (!thread)
      return createSilentError('Thread not found');
    if (!await thread.resume())
      return createSilentError('Unable to resume');
    return {allThreadsContinued: false};
  }

  async _onPause(params: Dap.PauseParams): Promise<Dap.PauseResult | Dap.Error> {
    const thread = this._targetManager.threads.get(params.threadId);
    if (!thread)
      return createSilentError('Thread not found');
    if (!await thread.pause())
      return createSilentError('Unable to pause');
    return {};
  }

  async _onNext(params: Dap.NextParams): Promise<Dap.NextResult | Dap.Error> {
    const thread = this._targetManager.threads.get(params.threadId);
    if (!thread)
      return createSilentError('Thread not found');
    if (!await thread.stepOver())
      return createSilentError('Unable to step next');
    return {};
  }

  async _onStepIn(params: Dap.StepInParams): Promise<Dap.StepInResult | Dap.Error> {
    const thread = this._targetManager.threads.get(params.threadId);
    if (!thread)
      return createSilentError('Thread not found');
    // TODO(dgozman): support |params.targetId|.
    if (!await thread.stepInto())
      return createSilentError('Unable to step in');
    return {};
  }

  async _onStepOut(params: Dap.StepOutParams): Promise<Dap.StepOutResult | Dap.Error> {
    const thread = this._targetManager.threads.get(params.threadId);
    if (!thread)
      return createSilentError('Thread not found');
    if (!await thread.stepOut())
      return createSilentError('Unable to step out');
    return {};
  }

  async _onStackTrace(params: Dap.StackTraceParams): Promise<Dap.StackTraceResult | Dap.Error> {
    const thread = this._targetManager.threads.get(params.threadId);
    if (!thread)
      return createSilentError('Thread not found');
    const details = thread.pausedDetails();
    if (!details)
      return createSilentError('Thread is not paused');

    const from = params.startFrame || 0;
    const to = params.levels ? from + params.levels : from + 1;
    const frames = await details.stackTrace.loadFrames(to);
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

  _findStackFrame(frameId: number): {stackFrame: StackFrame, thread: Thread} | undefined {
    let stackFrame: StackFrame | undefined;
    let thread: Thread | undefined;
    for (const t of this._targetManager.threads.values()) {
      const details = t.pausedDetails();
      if (!details)
        continue;
      stackFrame = details.stackTrace.frame(frameId);
      thread = t;
      if (stackFrame)
        break;
    }
    return stackFrame ? {stackFrame, thread: thread!} : undefined;
  }

  async _onScopes(params: Dap.ScopesParams): Promise<Dap.ScopesResult | Dap.Error> {
    const found = this._findStackFrame(params.frameId);
    if (!found)
      return createSilentError('Stack frame not found');
    const {stackFrame, thread} = found;
    if (!stackFrame.scopeChain)
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
      const variable = await thread.pausedVariables()!.createVariable(scope.object);
      const uiStartLocation = scope.startLocation
          ? this._sourceContainer.uiLocation(thread.locationFromDebugger(scope.startLocation))
          : undefined;
      const uiEndLocation = scope.endLocation
          ? this._sourceContainer.uiLocation(thread.locationFromDebugger(scope.endLocation))
          : undefined;
      if (scope.name && scope.type === 'closure') {
        name = `Closure (${scope.name})`;
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
        line: uiStartLocation ? uiStartLocation.lineNumber + 1 : undefined,
        column: uiStartLocation ? uiStartLocation.columnNumber + 1 : undefined,
        endLine: uiEndLocation ? uiEndLocation.lineNumber + 1 : undefined,
        endColumn: uiEndLocation ? uiEndLocation.columnNumber + 1 : undefined,
      });
    }
    return {scopes};
  }

  async _onVariables(params: Dap.VariablesParams): Promise<Dap.VariablesResult> {
    let variableStore: VariableStore | null = null;
    for (const target of this._targetManager.targets()) {
      const thread = target.thread()
      if (!thread)
        continue;
      if (thread.pausedVariables() && thread.pausedVariables()!.hasVariables(params))
        variableStore = thread.pausedVariables();
      if (thread.replVariables.hasVariables(params))
        variableStore = thread.replVariables;
      if (variableStore)
        break;
    }
    if (!variableStore)
      return { variables: [] };
    return {variables: await variableStore.getVariables(params)};
  }

  async _onEvaluate(args: Dap.EvaluateParams): Promise<Dap.EvaluateResult | Dap.Error> {
    if (!this._mainTarget)
      return this._mainTargetNotAvailable();
    if (args.frameId !== undefined) {
      const found = this._findStackFrame(args.frameId);
      if (!found)
        return createSilentError('Stack frame not found');
      const exception = found.thread.pausedDetails()!.exception;
      if (exception && args.expression === this._exceptionEvaluateName)
        return this._evaluateResult(found.thread.pausedVariables()!, exception);
    }
    const response = await this._mainTarget.cdp().Runtime.evaluate({
      expression: args.expression,
      includeCommandLineAPI: true,
      objectGroup: 'console',
      generatePreview: true
    });

    if (!response)
      return createSilentError('Unable to evaluate');
    const thread = this._mainTarget.thread()!;
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
    if (!this._mainTarget)
      return {targets: []};
    const line = params.line === undefined ? 0 : params.line - 1;
    return {targets: await completionz.completions(this._mainTarget.cdp(), params.text, line, params.column)};
  }

  async _onLoadedSources(params: Dap.LoadedSourcesParams): Promise<Dap.LoadedSourcesResult> {
    return {sources: this._sourceContainer.sources().map(source => source.toDap())};
  }

  async _onSource(params: Dap.SourceParams): Promise<Dap.SourceResult | Dap.Error> {
    const source = this._sourceContainer.source(params.sourceReference);
    if (!source)
      return createSilentError('Source not found');
    const content = await source.content();
    if (content === undefined)
      return createSilentError('Unable to retrieve source content');
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
      return createSilentError('Thread not found');
    const details = thread.pausedDetails();
    const exception = details && details.exception;
    if (!exception)
      return createSilentError('Thread is not paused on exception');
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

  async _onUpdateCustomBreakpoints(params: Dap.UpdateCustomBreakpointsParams): Promise<Dap.UpdateCustomBreakpointsResult> {
    await this._targetManager.updateCustomBreakpoints(params.breakpoints);
    return {};
  }
}

function createSilentError(text: string): Dap.Error {
  return {
    __errorMarker: true,
    error: {
      id: 9222,
      format: text,
      showUser: false,
      sendTelemetry: false
    }
  };
}

function createUserError(text: string): Dap.Error {
  return {
    __errorMarker: true,
    error: {
      id: 9222,
      format: text,
      showUser: true,
      sendTelemetry: false
    }
  };
}
