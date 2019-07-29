/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Disposable, EventEmitter } from 'vscode';
import * as nls from 'vscode-nls';
import Dap from '../dap/api';
import * as sourceUtils from '../utils/sourceUtils';
import * as errors from './errors';
import { Location, SourceContainer } from './sources';
import { DummyThreadAdapter, ThreadAdapter } from './threadAdapter';
import { ExecutionContext, PauseOnExceptionsState, Thread, ThreadManager } from './threads';
import { VariableStore } from './variables';
import { BreakpointManager } from './breakpoints';

const localize = nls.loadMessageBundle();
const defaultThreadId = 0;
const revealLocationThreadId = 1;

export interface DebugAdapterDelegate {
  executionContextForest(): ExecutionContext[];
  adapterDisposed: () => void;
  onLaunch: (params: Dap.LaunchParams) => Promise<Dap.LaunchResult | Dap.Error>;
  onTerminate: (params: Dap.TerminateParams) => Promise<Dap.TerminateResult | Dap.Error>;
  onDisconnect: (params: Dap.DisconnectParams) => Promise<Dap.DisconnectResult | Dap.Error>;
  onRestart: (params: Dap.RestartParams) => Promise<Dap.RestartResult | Dap.Error>;
}

// This class collects configuration issued before "launch" request,
// to be applied after launch.
export class DebugAdapter {
  readonly dap: Dap.Api;
  readonly sourceContainer: SourceContainer;
  readonly threadManager: ThreadManager;
  readonly breakpointManager: BreakpointManager;
  private _threadAdapter: ThreadAdapter | DummyThreadAdapter;
  private _locationToReveal: Location | undefined;
  private _onExecutionContextForestChangedEmitter = new EventEmitter<ExecutionContext[]>();
  private _delegates = new Set<DebugAdapterDelegate>();
  readonly onExecutionContextForestChanged = this._onExecutionContextForestChangedEmitter.event;

  constructor(dap: Dap.Api) {
    this.dap = dap;
    this.dap.on('initialize', params => this._onInitialize(params));
    this.dap.on('setBreakpoints', params => this._onSetBreakpoints(params));
    this.dap.on('setExceptionBreakpoints', params => this._onSetExceptionBreakpoints(params));
    this.dap.on('configurationDone', params => this._onConfigurationDone(params));
    this.dap.on('loadedSources', params => this._onLoadedSources(params));
    this.dap.on('source', params => this._onSource(params));
    this.dap.on('threads', params => this._onThreads(params));
    this.dap.on('stackTrace', params => this._onStackTrace(params));
    this.dap.on('variables', params => this._onVariables(params));
    this.dap.on('setVariable', params => this._onSetVariable(params));
    this.dap.on('launch', params => this._onLaunch(params));
    this.dap.on('terminate', params => this._onTerminate(params));
    this.dap.on('disconnect', params => this._onDisconnect(params));
    this.dap.on('restart', params => this._onRestart(params));
    this.dap.thread({ reason: 'started', threadId: defaultThreadId });
    this.sourceContainer = new SourceContainer(this.dap);
    this.threadManager = new ThreadManager(this.dap, this.sourceContainer);
    this.breakpointManager = new BreakpointManager(this.dap, this.sourceContainer, this.threadManager);
    this._threadAdapter = new DummyThreadAdapter(this.dap);

    this.threadManager.onExecutionContextsChanged(_ => {
      this._onExecutionContextForestChangedEmitter.fire(this.executionContextForest());
    });

    const disposables: Disposable[] = [];
    this.threadManager.onThreadAdded(thread => {
      this._setExecutionContext(thread, undefined);
      disposables[0].dispose();
    }, undefined, disposables);
  }

  async _onInitialize(params: Dap.InitializeParams): Promise<Dap.InitializeResult | Dap.Error> {
    console.assert(params.linesStartAt1);
    console.assert(params.columnsStartAt1);
    this.dap.initialized({});
    return {
      supportsConfigurationDoneRequest: true,
      supportsFunctionBreakpoints: false,
      supportsConditionalBreakpoints: true,
      supportsHitConditionalBreakpoints: false,
      supportsEvaluateForHovers: true,
      exceptionBreakpointFilters: [
        { filter: 'caught', label: localize('breakpoint.caughtExceptions', 'Caught Exceptions'), default: false },
        { filter: 'uncaught', label: localize('breakpoint.uncaughtExceptions', 'Uncaught Exceptions'), default: false },
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
      supportsValueFormattingOptions: false,  // This is not used by vscode.
      supportsExceptionInfoRequest: true,
      supportTerminateDebuggee: false,
      supportsDelayedStackTraceLoading: true,
      supportsLoadedSourcesRequest: true,
      supportsLogPoints: true,
      supportsTerminateThreadsRequest: false,
      supportsSetExpression: false,
      supportsTerminateRequest: false,
      //supportsDataBreakpoints: false,
      //supportsReadMemoryRequest: false,
      //supportsDisassembleRequest: false,
    };
  }

  static resolvePausedOnExceptionsState(params: Dap.SetExceptionBreakpointsParams): PauseOnExceptionsState {
    if (params.filters.includes('caught'))
      return 'all';
    if (params.filters.includes('uncaught'))
      return 'uncaught';
    return 'none';
  }

  async _onSetBreakpoints(params: Dap.SetBreakpointsParams): Promise<Dap.SetBreakpointsResult | Dap.Error> {
    return this.breakpointManager.setBreakpoints(params);
  }

  async _onSetExceptionBreakpoints(params: Dap.SetExceptionBreakpointsParams): Promise<Dap.SetExceptionBreakpointsResult> {
    await this.threadManager.setPauseOnExceptionsState(DebugAdapter.resolvePausedOnExceptionsState(params));
    return {};
  }

  async _onConfigurationDone(_: Dap.ConfigurationDoneParams): Promise<Dap.ConfigurationDoneResult> {
    return {};
  }

  async _onLaunch(params: Dap.LaunchParams): Promise<Dap.LaunchResult | Dap.Error> {
    for (const delegate of this._delegates.values())
      delegate.onLaunch(params);
    return {};
  }

  async _onTerminate(params: Dap.TerminateParams): Promise<Dap.TerminateResult | Dap.Error> {
    for (const delegate of this._delegates)
      delegate.onTerminate(params);
    return {};
  }

  async _onDisconnect(params: Dap.DisconnectParams): Promise<Dap.DisconnectResult | Dap.Error> {
    for (const delegate of this._delegates.values())
      delegate.onDisconnect(params);
    return {};
  }

  async _onRestart(params: Dap.RestartParams): Promise<Dap.RestartResult | Dap.Error> {
    for (const delegate of this._delegates)
      delegate.onRestart(params);
    return {};
  }

  async _onLoadedSources(_: Dap.LoadedSourcesParams): Promise<Dap.LoadedSourcesResult> {
    return { sources: await this.sourceContainer.loadedSources() };
  }

  async _onSource(params: Dap.SourceParams): Promise<Dap.SourceResult | Dap.Error> {
    const source = this.sourceContainer.source(params.source!);
    if (!source)
      return errors.createSilentError(localize('error.sourceNotFound', 'Source not found'));
    const content = await source.content();
    if (content === undefined)
      return errors.createSilentError(localize('error.sourceContentDidFail', 'Unable to retrieve source content'));
    return { content, mimeType: source.mimeType() };
  }

  async _onThreads(_: Dap.ThreadsParams): Promise<Dap.ThreadsResult | Dap.Error> {
    const threads = [{ id: defaultThreadId, name: 'PWA '}];
    if (this._locationToReveal)
      threads.push({ id: revealLocationThreadId, name: '' });
    return { threads };
  }

  async _onStackTrace(params: Dap.StackTraceParams): Promise<Dap.StackTraceResult | Dap.Error> {
    if (params.threadId === revealLocationThreadId)
      return this._syntheticStackTraceForSourceReveal(params);
    return this._threadAdapter.onStackTrace(params);
  }

  _findVariableStore(variablesReference: number): VariableStore | undefined {
    for (const thread of this.threadManager.threads()) {
      if (thread.pausedVariables() && thread.pausedVariables()!.hasVariables(variablesReference))
        return thread.pausedVariables();
      if (thread.replVariables.hasVariables(variablesReference))
        return thread.replVariables;
    }
  }

  async _onVariables(params: Dap.VariablesParams): Promise<Dap.VariablesResult> {
    let variableStore = this._findVariableStore(params.variablesReference);
    if (!variableStore)
      return { variables: [] };
    return { variables: await variableStore.getVariables(params) };
  }

  async _onSetVariable(params: Dap.SetVariableParams): Promise<Dap.SetVariableResult | Dap.Error> {
    let variableStore = this._findVariableStore(params.variablesReference);
    if (!variableStore)
      return errors.createSilentError(localize('error.variableNotFound', 'Variable not found'));
    params.value = sourceUtils.wrapObjectLiteral(params.value.trim());
    return variableStore.setVariable(params);
  }

  async addDelegate(delegate: DebugAdapterDelegate): Promise<void> {
    this._delegates.add(delegate);
    this._onExecutionContextForestChangedEmitter.fire(this.executionContextForest());
  }

  async removeDelegate(delegate: DebugAdapterDelegate): Promise<void> {
    this._delegates.delete(delegate);
    if (!this._delegates.size)
      this.dap.terminated({});
    this._onExecutionContextForestChangedEmitter.fire(this.executionContextForest());
  }

  async revealLocation(location: Location, revealConfirmed: Promise<void>) {
    // 1. Report about a new thread.
    // 2. Report that thread has stopped.
    // 3. Wait for stackTrace call, return a single frame pointing to |location|.
    // 4. Wait for the source to be opened in the editor.
    // 5. Report thread as continuted and terminated.
    if (this._locationToReveal)
      return;
    this._locationToReveal = location;
    this.dap.thread({ reason: 'started', threadId: revealLocationThreadId });
    this.dap.stopped({
      reason: 'goto',
      threadId: revealLocationThreadId,
      allThreadsStopped: false,
    });

    await revealConfirmed;

    this.dap.continued({ threadId: revealLocationThreadId, allThreadsContinued: false });
    this.dap.thread({ reason: 'exited', threadId: revealLocationThreadId });
    this._locationToReveal = undefined;
  }

  executionContextForest(): ExecutionContext[] {
    const result: ExecutionContext[] = [];
    for (const delegate of this._delegates)
      result.push(...delegate.executionContextForest());
    return result;
  }

  selectExecutionContext(context: ExecutionContext | undefined) {
    if (context) {
      const description = context.description || context.thread.defaultExecutionContext();
      this._setExecutionContext(context.thread, description ? description.id : undefined);
    } else {
      const thread = this.threadManager.mainThread();
      const defaultContext = thread ? thread.defaultExecutionContext() : undefined;
      this._setExecutionContext(thread, defaultContext ? defaultContext.id : undefined);
    }
  }

  _setExecutionContext(thread: Thread | undefined, executionContextId: number | undefined) {
    if (this._threadAdapter)
      this._threadAdapter.dispose();
    if (thread)
      this._threadAdapter = new ThreadAdapter(this.dap, thread, executionContextId);
    else
      this._threadAdapter = new DummyThreadAdapter(this.dap);

    const details = thread ? thread.pausedDetails() : undefined;
    if (details) {
      this.dap.stopped({
        reason: details.reason,
        description: details.description,
        threadId: defaultThreadId,
        text: details.text,
        allThreadsStopped: false
      });
    } else {
      this.dap.continued({
        threadId: defaultThreadId,
        allThreadsContinued: false
      });
    }
  }

  async _syntheticStackTraceForSourceReveal(params: Dap.StackTraceParams): Promise<Dap.StackTraceResult> {
    if (!this._locationToReveal || params.startFrame)
      return { stackFrames: [] };
    return {
      stackFrames: [{
        id: 1,
        name: '',
        line: this._locationToReveal.lineNumber,
        column: this._locationToReveal.columnNumber,
        source: await this._locationToReveal.source!.toDap()
      }]
    };
  }

  _threadNotAvailableError(): Dap.Error {
    return errors.createSilentError(localize('error.threadNotFound', 'Thread not found'));
  }

  dispose() {
    for (const delegate of this._delegates)
      delegate.adapterDisposed();
  }
}
