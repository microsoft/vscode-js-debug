/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Dap from '../dap/api';

import CdpConnection from '../cdp/connection';
import {Target, TargetEvents} from './targetManager';
import findChrome from '../chrome/findChrome';
import * as launcher from '../chrome/launcher';
import * as completionz from './completions';
import {Thread} from './thread';
import {StackFrame} from './stackTrace';
import {LaunchParams, Context} from './context';

export class Adapter {
  private _dap: Dap.Api;
  private _context: Context;
  private _mainTarget: Target;

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
    connection.on(CdpConnection.Events.Disconnected, () => this._dap.exited({exitCode: 0}));

    this._context = new Context(this._dap, connection);

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
    this._mainTarget = this._context.targetManager.mainTarget();
    if (!this._mainTarget)
      this._mainTarget = await new Promise(f => this._context.targetManager.once(TargetEvents.TargetAttached, f)) as Target;
    this._context.targetManager.on(TargetEvents.TargetDetached, (target: Target) => {
      if (target === this._mainTarget) {
        this._dap.terminated({});
      }
    });
    return {};
  }

  async _onLaunch(params: LaunchParams): Promise<Dap.LaunchResult> {
    if (!this._mainTarget)
      await this._onConfigurationDone({});

    // params.noDebug
    this._context.initialize(params);
    this._mainTarget.cdp().Page.navigate({url: params.url});
    return {};
  }

  _mainTargetNotAvailable(): Dap.Error {
    return this._context.createSilentError('Page is not available');
  }

  async _onTerminate(params: Dap.TerminateParams): Promise<Dap.TerminateResult | Dap.Error> {
    if (!this._mainTarget)
      return this._mainTargetNotAvailable();
    this._mainTarget.cdp().Page.navigate({url: 'about:blank'});
    return {};
  }

  async _onDisconnect(params: Dap.DisconnectParams): Promise<Dap.DisconnectResult | Dap.Error> {
    if (!this._context)
      return this._mainTargetNotAvailable();
    this._context.browser.Browser.close();
    return {};
  }

  async _onRestart(params: Dap.RestartParams): Promise<Dap.RestartResult | Dap.Error> {
    if (!this._mainTarget)
      return this._mainTargetNotAvailable();
    this._mainTarget.cdp().Page.navigate({url: this._context.launchParams.url});
    return {};
  }

  async _onThreads(params: Dap.ThreadsParams): Promise<Dap.ThreadsResult | Dap.Error> {
    const threads = [];
    for (const thread of this._context.threads.values())
      threads.push({id: thread.threadId(), name: thread.threadName()});
    return {threads};
  }

  async _onContinue(params: Dap.ContinueParams): Promise<Dap.ContinueResult | Dap.Error> {
    const thread = this._context.threads.get(params.threadId);
    if (!thread)
      return this._context.createSilentError('Thread not found');
    thread.resume();
    return {allThreadsContinued: false};
  }

  async _onStackTrace(params: Dap.StackTraceParams): Promise<Dap.StackTraceResult | Dap.Error> {
    const thread = this._context.threads.get(params.threadId);
    if (!thread)
      return this._context.createSilentError('Thread not found');
    const details = thread.pausedDetails();
    if (!details)
      return this._context.createSilentError('Thread is not paused');

    const from = params.startFrame || 0;
    const to = params.levels ? from + params.levels : from + 1;
    const frames = await details.stackTrace.loadFrames(to);
    const result: Dap.StackFrame[] = [];
    for (let index = from; index < to && index < frames.length; index++) {
      const stackFrame = frames[index];
      const uiLocation = this._context.sourceContainer.uiLocation(stackFrame.location);
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

  async _onScopes(params: Dap.ScopesParams): Promise<Dap.ScopesResult | Dap.Error> {
    let stackFrame: StackFrame | undefined;
    let frameThread: Thread | undefined;
    for (const thread of this._context.threads.values()) {
      if (!thread.pausedDetails())
        continue;
      stackFrame = thread.pausedDetails().stackTrace.frame(params.frameId);
      frameThread = thread;
      if (stackFrame)
        break;
    }
    if (!stackFrame || !stackFrame.scopeChain)
      return this._context.createSilentError('Stack frame not found');
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
      const variable = await this._context.variableStore.createVariable(frameThread.cdp(), scope.object);
      const uiStartLocation = scope.startLocation
          ? this._context.sourceContainer.uiLocation(frameThread.locationFromDebugger(scope.startLocation))
          : undefined;
      const uiEndLocation = scope.endLocation
          ? this._context.sourceContainer.uiLocation(frameThread.locationFromDebugger(scope.endLocation))
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
    return {variables: await this._context.variableStore.getVariables(params)};
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
    const variable = await this._context.variableStore.createVariable(this._mainTarget.cdp(), response.result, args.context);
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
    return {sources: this._context.sourceContainer.sources().map(source => source.toDap())};
  }

  async _onSource(params: Dap.SourceParams): Promise<Dap.SourceResult> {
    const source = this._context.sourceContainer.source(params.sourceReference);
    if (!source)
      return {content: '', mimeType: 'text/javascript'};
    return {content: await source.content(), mimeType: source.mimeType()};
  }

  async _onSetBreakpoints(params: Dap.SetBreakpointsParams): Promise<Dap.SetBreakpointsResult> {
    return {breakpoints: []};
  }
}
