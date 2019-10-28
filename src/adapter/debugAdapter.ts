// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Disposable } from '../common/events';
import * as nls from 'vscode-nls';
import Dap from '../dap/api';
import * as sourceUtils from '../common/sourceUtils';
import * as urlUtils from '../common/urlUtils';
import * as errors from '../dap/errors';
import { SourceContainer, UiLocation } from './sources';
import { Thread, ThreadDelegate, PauseOnExceptionsState } from './threads';
import { VariableStore } from './variables';
import { BreakpointManager, generateBreakpointIds } from './breakpoints';
import { Cdp } from '../cdp/api';
import { ISourcePathResolver } from '../common/sourcePathResolver';
import { AnyLaunchConfiguration } from '../configuration';

const localize = nls.loadMessageBundle();

// This class collects configuration issued before "launch" request,
// to be applied after launch.
export class DebugAdapter {
  readonly dap: Dap.Api;
  readonly sourceContainer: SourceContainer;
  readonly breakpointManager: BreakpointManager;
  private _disposables: Disposable[] = [];
  private _pauseOnExceptionsState: PauseOnExceptionsState = 'none';
  private _customBreakpoints = new Set<string>();
  private _thread: Thread | undefined;

  constructor(dap: Dap.Api, rootPath: string | undefined, sourcePathResolver: ISourcePathResolver, private readonly launchConfig: AnyLaunchConfiguration) {
    this.dap = dap;
    this.dap.on('initialize', params => this._onInitialize(params));
    this.dap.on('setBreakpoints', params => this._onSetBreakpoints(params));
    this.dap.on('setExceptionBreakpoints', params => this.setExceptionBreakpoints(params));
    this.dap.on('configurationDone', params => this.configurationDone(params));
    this.dap.on('loadedSources', params => this._onLoadedSources(params));
    this.dap.on('source', params => this._onSource(params));
    this.dap.on('threads', params => this._onThreads(params));
    this.dap.on('stackTrace', params => this._onStackTrace(params));
    this.dap.on('variables', params => this._onVariables(params));
    this.dap.on('setVariable', params => this._onSetVariable(params));
    this.dap.on('continue', params => this._withThread(thread => thread.resume()));
    this.dap.on('pause', params => this._withThread(thread => thread.pause()));
    this.dap.on('next', params => this._withThread(thread => thread.stepOver()));
    this.dap.on('stepIn', params => this._withThread(thread => thread.stepInto()));
    this.dap.on('stepOut', params => this._withThread(thread => thread.stepOut()));
    this.dap.on('restartFrame', params => this._withThread(thread => thread.restartFrame(params)));
    this.dap.on('scopes', params => this._withThread(thread => thread.scopes(params)));
    this.dap.on('evaluate', params => this._withThread(thread => thread.evaluate(params)));
    this.dap.on('completions', params => this._withThread(thread => thread.completions(params)));
    this.dap.on('exceptionInfo', params => this._withThread(thread => thread.exceptionInfo()));
    this.dap.on('enableCustomBreakpoints', params => this.enableCustomBreakpoints(params));
    this.dap.on('disableCustomBreakpoints', params => this._disableCustomBreakpoints(params));
    this.dap.on('canPrettyPrintSource', params => this._canPrettyPrintSource(params));
    this.dap.on('prettyPrintSource', params => this._prettyPrintSource(params));
    this.sourceContainer = new SourceContainer(this.dap, rootPath, sourcePathResolver);
    this.breakpointManager = new BreakpointManager(this.dap, this.sourceContainer);
  }

  async _onInitialize(params: Dap.InitializeParams): Promise<Dap.InitializeResult | Dap.Error> {
    console.assert(params.linesStartAt1);
    console.assert(params.columnsStartAt1);
    const capabilities = DebugAdapter.capabilities();
    setTimeout(() => this.dap.initialized({}), 0);
    return capabilities;
  }

  static capabilities(): Dap.Capabilities {
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
      completionTriggerCharacters: ['.', '[', '"', "'"]
      //supportsDataBreakpoints: false,
      //supportsReadMemoryRequest: false,
      //supportsDisassembleRequest: false,
    };
  }

  async _onSetBreakpoints(params: Dap.SetBreakpointsParams): Promise<Dap.SetBreakpointsResult | Dap.Error> {
    const ids = generateBreakpointIds(params);
    setTimeout(() => {
       throw new Error('aweffeaw');
    }, 10000);
    return this.breakpointManager.setBreakpoints(params, ids);
  }

  async setExceptionBreakpoints(params: Dap.SetExceptionBreakpointsParams): Promise<Dap.SetExceptionBreakpointsResult> {
    this._pauseOnExceptionsState = 'none';
    if (params.filters.includes('caught'))
      this._pauseOnExceptionsState = 'all';
    else if (params.filters.includes('uncaught'))
      this._pauseOnExceptionsState = 'uncaught';
    if (this._thread)
      await this._thread.setPauseOnExceptionsState(this._pauseOnExceptionsState);
    return {};
  }

  async configurationDone(_: Dap.ConfigurationDoneParams): Promise<Dap.ConfigurationDoneResult> {
    return {};
  }

  async _onLoadedSources(_: Dap.LoadedSourcesParams): Promise<Dap.LoadedSourcesResult> {
    return { sources: await this.sourceContainer.loadedSources() };
  }

  async _onSource(params: Dap.SourceParams): Promise<Dap.SourceResult | Dap.Error> {
    params.source!.path = urlUtils.platformPathToPreferredCase(params.source!.path);
    const source = this.sourceContainer.source(params.source!);
    if (!source)
      return errors.createSilentError(localize('error.sourceNotFound', 'Source not found'));
    const content = await source.content();
    if (content === undefined)
      return errors.createSilentError(localize('error.sourceContentDidFail', 'Unable to retrieve source content'));
    return { content, mimeType: source.mimeType() };
  }

  async _onThreads(_: Dap.ThreadsParams): Promise<Dap.ThreadsResult | Dap.Error> {
    const threads: Dap.Thread[] = [];
    if (this._thread)
      threads.push({ id: this._thread.id, name: this._thread.name() });
    return { threads };
  }

  async _onStackTrace(params: Dap.StackTraceParams): Promise<Dap.StackTraceResult | Dap.Error> {
    if (!this._thread)
      return this._threadNotAvailableError();
    return this._thread.stackTrace(params);
  }

  _findVariableStore(variablesReference: number): VariableStore | undefined {
    if (!this._thread)
      return;
    if (this._thread.pausedVariables() && this._thread.pausedVariables()!.hasVariables(variablesReference))
      return this._thread.pausedVariables();
    if (this._thread.replVariables.hasVariables(variablesReference))
      return this._thread.replVariables;
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

  _withThread<T>(callback: (thread: Thread) => Promise<T>): Promise<T | Dap.Error> {
    if (!this._thread)
      return Promise.resolve(this._threadNotAvailableError());
    return callback(this._thread);
  }

  _refreshStackTrace() {
    if (!this._thread)
      return;
    const details = this._thread.pausedDetails();
    if (details)
      this._thread.refreshStackTrace();
  }

  _threadNotAvailableError(): Dap.Error {
    return errors.createSilentError(localize('error.threadNotFound', 'Thread not found'));
  }

  createThread(threadName: string, cdp: Cdp.Api, delegate: ThreadDelegate): Thread {
    this._thread = new Thread(this.sourceContainer, threadName, cdp, this.dap, delegate, this.launchConfig);
    for (const breakpoint of this._customBreakpoints)
      this._thread.updateCustomBreakpoint(breakpoint, true);
    this._thread.setPauseOnExceptionsState(this._pauseOnExceptionsState);
    this.breakpointManager.setThread(this._thread);
    return this._thread;
  }

  async enableCustomBreakpoints(params: Dap.EnableCustomBreakpointsParams): Promise<Dap.EnableCustomBreakpointsResult> {
    const promises: Promise<void>[] = [];
    for (const id of params.ids) {
      this._customBreakpoints.add(id);
      if (this._thread)
        promises.push(this._thread.updateCustomBreakpoint(id, true));
    }
    await Promise.all(promises);
    return {};
  }

  async _disableCustomBreakpoints(params: Dap.DisableCustomBreakpointsParams): Promise<Dap.DisableCustomBreakpointsResult> {
    const promises: Promise<void>[] = [];
    for (const id of params.ids) {
      this._customBreakpoints.delete(id);
      if (this._thread)
        promises.push(this._thread.updateCustomBreakpoint(id, false));
    }
    await Promise.all(promises);
    return {};
  }

  async _canPrettyPrintSource(params: Dap.CanPrettyPrintSourceParams): Promise<Dap.CanPrettyPrintSourceResult | Dap.Error> {
    params.source!.path = urlUtils.platformPathToPreferredCase(params.source!.path);
    const source = this.sourceContainer.source(params.source!);
    if (!source)
      return errors.createSilentError(localize('error.sourceNotFound', 'Source not found'));
    return { canPrettyPrint: source.canPrettyPrint() };
  }

  async _prettyPrintSource(params: Dap.PrettyPrintSourceParams): Promise<Dap.PrettyPrintSourceResult | Dap.Error> {
    params.source!.path = urlUtils.platformPathToPreferredCase(params.source!.path);
    const source = this.sourceContainer.source(params.source!);
    if (!source)
      return errors.createSilentError(localize('error.sourceNotFound', 'Source not found'));

    if (!source.canPrettyPrint() || !(await source.prettyPrint()))
      return errors.createSilentError(localize('error.cannotPrettyPrint', 'Unable to pretty print'));

    this._refreshStackTrace();
    if (params.line) {
      const originalUiLocation: UiLocation = {
        source,
        lineNumber: params.line || 1,
        columnNumber: params.column || 1,
      };
      const newUiLocation = await this.sourceContainer.preferredUiLocation(originalUiLocation);
      this.sourceContainer.revealUiLocation(newUiLocation);
    }
    return {};
  }

  dispose() {
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables = [];
  }
}
