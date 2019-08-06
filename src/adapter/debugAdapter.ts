// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Disposable } from 'vscode';
import Dap from '../dap/api';
import * as sourceUtils from '../utils/sourceUtils';
import * as errors from './errors';
import { Location, SourceContainer } from './sources';
import { PauseOnExceptionsState, ThreadManager, Thread } from './threads';
import { VariableStore } from './variables';
import { BreakpointManager } from './breakpoints';
import { UIDelegate } from '../utils/uiDelegate';

const revealLocationThreadId = 999999999;

export interface DebugAdapterDelegate {
  onSetBreakpoints: (params: Dap.SetBreakpointsParams) => Promise<void>;
}

// This class collects configuration issued before "launch" request,
// to be applied after launch.
export class DebugAdapter {
  readonly dap: Dap.Api;
  readonly sourceContainer: SourceContainer;
  readonly threadManager: ThreadManager;
  readonly breakpointManager: BreakpointManager;
  private _locationToReveal: Location | undefined;
  private _delegate: DebugAdapterDelegate;
  private _disposables: Disposable[] = [];
  private _selectedThread?: Thread;
  private _uiDelegate: UIDelegate;

  constructor(dap: Dap.Api, delegate: DebugAdapterDelegate, uiDelegate: UIDelegate) {
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
    this.dap.on('continue', params => this._withThread(params.threadId, thread => thread.resume())),
    this.dap.on('pause', params => this._withThread(params.threadId, thread => thread.pause())),
    this.dap.on('next', params => this._withThread(params.threadId, thread => thread.stepOver())),
    this.dap.on('stepIn', params => this._withThread(params.threadId, thread => thread.stepInto())),
    this.dap.on('stepOut', params => this._withThread(params.threadId, thread => thread.stepOut())),
    this.dap.on('restartFrame', params => this._withFrame(params.frameId, thread => thread.restartFrame(params))),
    this.dap.on('scopes', params => this._withFrame(params.frameId, thread => thread.scopes(params))),
    this.dap.on('evaluate', params => this._onEvaluate(params)),
    this.dap.on('completions', params => this._onCompletions(params)),
    this.dap.on('exceptionInfo', params => this._withThread(params.threadId, thread => thread.exceptionInfo())),
    this._delegate = delegate;
    this._uiDelegate = uiDelegate;
    this.sourceContainer = new SourceContainer(this.dap);
    this.threadManager = new ThreadManager(this.dap, this.sourceContainer, uiDelegate);
    this.breakpointManager = new BreakpointManager(this.dap, this.sourceContainer, this.threadManager);

    this.threadManager.onThreadAdded(thread => this.dap.thread({
      reason: 'started',
      threadId: this.threadManager.dapIdByThread(thread)
    }), undefined, this._disposables);
    this.threadManager.onThreadRemoved(thread => {
      this.dap.thread({
        reason: 'exited',
        threadId: this.threadManager.dapIdByThread(thread)
      });
      if (this._selectedThread === thread)
        this._selectedThread = undefined;
    }, undefined, this._disposables);
    this.threadManager.onThreadPaused(thread => this._onThreadPaused(thread), undefined, this._disposables);
    this.threadManager.onThreadResumed(thread => this._onThreadResumed(thread), undefined, this._disposables);
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
        { filter: 'caught', label: this._uiDelegate.localize('breakpoint.caughtExceptions', 'Caught Exceptions'), default: false },
        { filter: 'uncaught', label: this._uiDelegate.localize('breakpoint.uncaughtExceptions', 'Uncaught Exceptions'), default: false },
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

  async _onSetBreakpoints(params: Dap.SetBreakpointsParams): Promise<Dap.SetBreakpointsResult | Dap.Error> {
    await this._delegate.onSetBreakpoints(params);
    return this.breakpointManager.setBreakpoints(params);
  }

  async _onSetExceptionBreakpoints(params: Dap.SetExceptionBreakpointsParams): Promise<Dap.SetExceptionBreakpointsResult> {
    let pauseOnExceptionsState: PauseOnExceptionsState = 'none';
    if (params.filters.includes('caught'))
      pauseOnExceptionsState = 'all';
    else if (params.filters.includes('uncaught'))
      pauseOnExceptionsState = 'uncaught';
    await this.threadManager.setPauseOnExceptionsState(pauseOnExceptionsState);
    return {};
  }

  async _onConfigurationDone(_: Dap.ConfigurationDoneParams): Promise<Dap.ConfigurationDoneResult> {
    return {};
  }

  async _onLoadedSources(_: Dap.LoadedSourcesParams): Promise<Dap.LoadedSourcesResult> {
    return { sources: await this.sourceContainer.loadedSources() };
  }

  async _onSource(params: Dap.SourceParams): Promise<Dap.SourceResult | Dap.Error> {
    const source = this.sourceContainer.source(params.source!);
    if (!source)
      return errors.createSilentError(this._uiDelegate.localize('error.sourceNotFound', 'Source not found'));
    const content = await source.content();
    if (content === undefined)
      return errors.createSilentError(this._uiDelegate.localize('error.sourceContentDidFail', 'Unable to retrieve source content'));
    return { content, mimeType: source.mimeType() };
  }

  async _onThreads(_: Dap.ThreadsParams): Promise<Dap.ThreadsResult | Dap.Error> {
    const threads = this.threadManager.threads().map(thread => {
      return { id: this.threadManager.dapIdByThread(thread), name: thread.name() };
    });
    if (this._locationToReveal)
      threads.push({ id: revealLocationThreadId, name: '' });
    return { threads };
  }

  async _onStackTrace(params: Dap.StackTraceParams): Promise<Dap.StackTraceResult | Dap.Error> {
    if (params.threadId === revealLocationThreadId)
      return this._syntheticStackTraceForSourceReveal(params);
    const thread = this.threadManager.threadByDapId(params.threadId);
    if (!thread)
      return this._threadNotAvailableError();
    return thread.stackTrace(params);
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
      return errors.createSilentError(this._uiDelegate.localize('error.variableNotFound', 'Variable not found'));
    params.value = sourceUtils.wrapObjectLiteral(params.value.trim());
    return variableStore.setVariable(params);
  }

  _withThread<T>(threadId: number, callback: (thread: Thread) => Promise<T>): Promise<T | Dap.Error> {
    const thread = this.threadManager.threadByDapId(threadId);
    if (!thread)
      return Promise.resolve(this._threadNotAvailableError());
    return callback(thread);
  }

  _withFrame<T>(frameId: number, callback: (thread: Thread) => Promise<T>): Promise<T | Dap.Error> {
    const thread = this.threadManager.threadByFrameId(frameId);
    if (!thread)
      return Promise.resolve(this._stackFrameNotFoundError());
    return callback(thread);
  }

  _onEvaluate(params: Dap.EvaluateParams): Promise<Dap.EvaluateResult | Dap.Error> {
    if (params.frameId)
      return this._withFrame(params.frameId, thread => thread.evaluate(params));
    const thread = this._selectedThread || this.threadManager.threads()[0];
    if (!thread)
      return Promise.resolve(this._threadNotAvailableError());
    return thread.evaluate(params);
  }

  _onCompletions(params: Dap.CompletionsParams): Promise<Dap.CompletionsResult | Dap.Error> {
    if (params.frameId)
      return this._withFrame(params.frameId, thread => thread.completions(params));
    const thread = this._selectedThread || this.threadManager.threads()[0];
    if (!thread)
      return Promise.resolve(this._threadNotAvailableError());
    return thread.completions(params);
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

    for (const thread of this.threadManager.threads()) {
      const details = thread.pausedDetails();
      if (details) {
        thread.refreshStackTrace();
        this._onThreadResumed(thread);
        this._onThreadPaused(thread);
      }
    }
  }

  selectThread(thread: Thread | undefined) {
    this._selectedThread = thread;
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

  _onThreadPaused(thread: Thread) {
    const details = thread.pausedDetails()!;
    this.dap.stopped({
      reason: details.reason,
      description: details.description,
      threadId: this.threadManager.dapIdByThread(thread),
      text: details.text,
      allThreadsStopped: false
    });
  }

  _onThreadResumed(thread: Thread) {
    this.dap.continued({
      threadId: this.threadManager.dapIdByThread(thread),
      allThreadsContinued: false
    });
  }

  _threadNotAvailableError(): Dap.Error {
    return errors.createSilentError(this._uiDelegate.localize('error.threadNotFound', 'Thread not found'));
  }

  _stackFrameNotFoundError(): Dap.Error {
    return errors.createSilentError(this._uiDelegate.localize('error.stackFrameNotFound', 'Stack frame not found'));
  }

  dispose() {
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables = [];
  }
}
