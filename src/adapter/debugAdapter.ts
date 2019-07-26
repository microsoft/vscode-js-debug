/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as nls from 'vscode-nls';
import Dap from '../dap/api';
import { BreakpointManager, generateBreakpointId } from './breakpoints';
import * as errors from './errors';
import { Location, SourceContainer, SourcePathResolver } from './sources';
import { ThreadAdapter } from './threadAdapter';
import { ExecutionContext, PauseOnExceptionsState, ThreadManager, ThreadManagerDelegate } from './threads';

const localize = nls.loadMessageBundle();
const defaultThreadId = 0;
const revealLocationThreadId = 1;

export type SetBreakpointRequest = {
  params: Dap.SetBreakpointsParams;
  generatedIds: number[];
};

export interface DebugAdapterDelegate extends ThreadManagerDelegate {
  sourcePathResolverFactory: () => SourcePathResolver;
  adapterDisposed: () => void;
}

// This class collects configuration issued before "launch" request,
// to be applied after launch.
export class DebugAdapter {
  private _setBreakpointRequests: SetBreakpointRequest[] = [];
  private _pausedOnExceptionsState: PauseOnExceptionsState = 'none';
  private _dap: Dap.Api;
  private _sourceContainer: SourceContainer | undefined;
  private _threadManager: ThreadManager | undefined;
  private _breakpointManager: BreakpointManager | undefined;
  private _delegate: DebugAdapterDelegate;
  private _threadAdapter: ThreadAdapter | undefined;
  private _locationToReveal: Location | undefined;

  constructor(dap: Dap.Api) {
    this._dap = dap;
    this._dap.on('initialize', params => this._onInitialize(params));
    this._dap.on('setBreakpoints', params => this._onSetBreakpoints(params));
    this._dap.on('setExceptionBreakpoints', params => this._onSetExceptionBreakpoints(params));
    this._dap.on('configurationDone', params => this._onConfigurationDone(params));
    this._dap.on('loadedSources', params => this._onLoadedSources(params));
    this._dap.on('source', params => this._onSource(params));
    this._dap.on('threads', params => this._onThreads(params));
    this._dap.on('stackTrace', params => this._onStackTrace(params));
    this._dap.thread({ reason: 'started', threadId: defaultThreadId });
  }

  async _onInitialize(params: Dap.InitializeParams): Promise<Dap.InitializeResult | Dap.Error> {
    console.assert(params.linesStartAt1);
    console.assert(params.columnsStartAt1);
    this._dap.initialized({});
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
    if (this._breakpointManager)
      return this._breakpointManager.setBreakpoints(params);

    const request: SetBreakpointRequest = {
      params,
      generatedIds: []
    };
    this._setBreakpointRequests.push(request);
    const result: Dap.SetBreakpointsResult = { breakpoints: [] };
    for (const _ of params.breakpoints || []) {
      const id = generateBreakpointId();
      request.generatedIds.push(id);
      result.breakpoints.push({ id, verified: false });
    }
    return result;
  }

  async _onSetExceptionBreakpoints(params: Dap.SetExceptionBreakpointsParams): Promise<Dap.SetExceptionBreakpointsResult> {
    this._pausedOnExceptionsState = DebugAdapter.resolvePausedOnExceptionsState(params);
    if (this._threadManager)
      await this._threadManager.setPauseOnExceptionsState(this._pausedOnExceptionsState);
    return {};
  }

  async _onConfigurationDone(_: Dap.ConfigurationDoneParams): Promise<Dap.ConfigurationDoneResult> {
    return {};
  }

  async _onLoadedSources(_: Dap.LoadedSourcesParams): Promise<Dap.LoadedSourcesResult> {
    if (!this._sourceContainer)
      return { sources: [] };
    return { sources: await Promise.all(this._sourceContainer.sources().map(source => source.toDap())) };
  }

  async _onSource(params: Dap.SourceParams): Promise<Dap.SourceResult | Dap.Error> {
    const source = this._sourceContainer ? this._sourceContainer.source(params.source!) : undefined;
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
    if (this._threadAdapter)
      return this._threadAdapter.onStackTrace(params);
    return this._threadNotAvailableError();
  }

  async launch(delegate: DebugAdapterDelegate): Promise<void> {
    this._delegate = delegate;
    const sourcePathResolver = delegate.sourcePathResolverFactory();
    this._sourceContainer = new SourceContainer(this._dap, sourcePathResolver);
    this._threadManager = new ThreadManager(this._dap, sourcePathResolver, this._sourceContainer, delegate);
    this._breakpointManager = new BreakpointManager(this._dap, sourcePathResolver, this._sourceContainer, this._threadManager);

    this._threadAdapter = new ThreadAdapter(this._dap);
    await this._threadManager.setPauseOnExceptionsState(this._pausedOnExceptionsState);
    for (const request of this._setBreakpointRequests)
      await this._breakpointManager.setBreakpoints(request.params, request.generatedIds);

    // Select first thread once it is available.
    this._threadManager.onThreadAdded(thread => {
      if (!this._threadAdapter!.thread()) {
        this._threadAdapter!.setExecutionContext(thread, undefined);
      }
    });
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
    this._dap.thread({ reason: 'started', threadId: revealLocationThreadId });
    this._dap.stopped({
      reason: 'goto',
      threadId: revealLocationThreadId,
      allThreadsStopped: false,
    });

    await revealConfirmed;

    this._dap.continued({ threadId: revealLocationThreadId, allThreadsContinued: false });
    this._dap.thread({ reason: 'exited', threadId: revealLocationThreadId });
    this._locationToReveal = undefined;
  }

  selectExecutionContext(context: ExecutionContext | undefined) {
    if (!this._threadAdapter)
      return;
    let thread = context ? context.thread : undefined;
    if (thread) {
      let description = context!.description;
      if (!description) {
        const defaultContext = thread.defaultExecutionContext();
        description = defaultContext ? defaultContext : undefined;
      }
      this._threadAdapter!.setExecutionContext(thread, description ? description.id : undefined);
    } else {
      thread = this._threadManager!.mainThread();
      const defaultContext = thread ? thread.defaultExecutionContext() : undefined;
      this._threadAdapter!.setExecutionContext(thread, defaultContext ? defaultContext.id : undefined);
    }

    const details = thread ? thread.pausedDetails() : undefined;
    if (details) {
      this._dap.stopped({
        reason: details.reason,
        description: details.description,
        threadId: defaultThreadId,
        text: details.text,
        allThreadsStopped: false
      });
    } else {
      this._dap.continued({
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

  threadManager(): ThreadManager {
    return this._threadManager!;
  }

  sourceContainer(): SourceContainer {
    return this._sourceContainer!;
  }

  dispose() {
    this._delegate.adapterDisposed();
  }
}
