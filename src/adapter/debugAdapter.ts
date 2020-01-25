/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as nls from 'vscode-nls';
import Dap from '../dap/api';
import * as sourceUtils from '../common/sourceUtils';
import * as urlUtils from '../common/urlUtils';
import * as errors from '../dap/errors';
import { SourceContainer, IUiLocation } from './sources';
import { Thread, IThreadDelegate, PauseOnExceptionsState } from './threads';
import { VariableStore } from './variables';
import { BreakpointManager, generateBreakpointIds } from './breakpoints';
import { Cdp } from '../cdp/api';
import { ISourcePathResolver } from '../common/sourcePathResolver';
import { AnyLaunchConfiguration } from '../configuration';
import { TelemetryReporter } from '../telemetry/telemetryReporter';
import { CodeSearchSourceMapRepository } from '../common/sourceMaps/codeSearchSourceMapRepository';
import { BreakpointsPredictor, BreakpointPredictionCache } from './breakpointPredictor';
import { CorrelatedCache } from '../common/sourceMaps/mtimeCorrelatedCache';
import { join } from 'path';
import { IDeferred, getDeferred } from '../common/promiseUtil';
import { SourceMapCache } from './sourceMapCache';
import { logPerf } from '../telemetry/performance';
import { ScriptSkipper } from './scriptSkipper';
import { IAsyncStackPolicy } from './asyncStackPolicy';
import { logger } from '../common/logging/logger';
import { LogTag } from '../common/logging';
import { DisposableList } from '../common/disposable';

const localize = nls.loadMessageBundle();

// This class collects configuration issued before "launch" request,
// to be applied after launch.
export class DebugAdapter {
  readonly dap: Dap.Api;
  readonly sourceContainer: SourceContainer;
  readonly breakpointManager: BreakpointManager;
  private _disposables = new DisposableList();
  private _pauseOnExceptionsState: PauseOnExceptionsState = 'none';
  private _customBreakpoints = new Set<string>();
  private _thread: Thread | undefined;
  private _configurationDoneDeferred: IDeferred<void>;

  constructor(
    dap: Dap.Api,
    rootPath: string | undefined,
    sourcePathResolver: ISourcePathResolver,
    private readonly _scriptSkipper: ScriptSkipper,
    private readonly asyncStackPolicy: IAsyncStackPolicy,
    private readonly launchConfig: AnyLaunchConfiguration,
    private readonly _rawTelemetryReporter: TelemetryReporter,
  ) {
    this._configurationDoneDeferred = getDeferred();
    this.dap = dap;
    this.dap.on('initialize', params => this._onInitialize(params));
    this.dap.on('setBreakpoints', params => this._onSetBreakpoints(params));
    this.dap.on('setExceptionBreakpoints', params => this.setExceptionBreakpoints(params));
    this.dap.on('configurationDone', () => this.configurationDone());
    this.dap.on('loadedSources', () => this._onLoadedSources());
    this.dap.on('source', params => this._onSource(params));
    this.dap.on('threads', () => this._onThreads());
    this.dap.on('stackTrace', params => this._onStackTrace(params));
    this.dap.on('variables', params => this._onVariables(params));
    this.dap.on('setVariable', params => this._onSetVariable(params));
    this.dap.on('continue', () => this._withThread(thread => thread.resume()));
    this.dap.on('pause', () => this._withThread(thread => thread.pause()));
    this.dap.on('next', () => this._withThread(thread => thread.stepOver()));
    this.dap.on('stepIn', () => this._withThread(thread => thread.stepInto()));
    this.dap.on('stepOut', () => this._withThread(thread => thread.stepOut()));
    this.dap.on('restartFrame', params => this._withThread(thread => thread.restartFrame(params)));
    this.dap.on('scopes', params => this._withThread(thread => thread.scopes(params)));
    this.dap.on('evaluate', params => this._withThread(thread => thread.evaluate(params)));
    this.dap.on('completions', params => this._withThread(thread => thread.completions(params)));
    this.dap.on('exceptionInfo', () => this._withThread(thread => thread.exceptionInfo()));
    this.dap.on('enableCustomBreakpoints', params => this.enableCustomBreakpoints(params));
    this.dap.on('toggleSkipFileStatus', params => this._toggleSkipFileStatus(params));
    this.dap.on('disableCustomBreakpoints', params => this._disableCustomBreakpoints(params));
    this.dap.on('canPrettyPrintSource', params => this._canPrettyPrintSource(params));
    this.dap.on('prettyPrintSource', params => this._prettyPrintSource(params));
    this.dap.on('breakpointLocations', params =>
      this._withThread(async thread => ({
        breakpoints: await this.breakpointManager.getBreakpointLocations(thread, params),
      })),
    );

    const sourceMapRepo = CodeSearchSourceMapRepository.createOrFallback();
    const bpCache: BreakpointPredictionCache | undefined = launchConfig.__workspaceCachePath
      ? new CorrelatedCache(join(launchConfig.__workspaceCachePath, 'bp-predict.json'))
      : undefined;
    const sourceMapCache = new SourceMapCache();
    this._disposables.push(sourceMapCache);
    const bpPredictor = rootPath
      ? new BreakpointsPredictor(
          rootPath,
          launchConfig,
          sourceMapRepo,
          sourceMapCache,
          sourcePathResolver,
          bpCache,
        )
      : undefined;

    bpPredictor?.onLongParse(() => dap.longPrediction({}));

    this.sourceContainer = new SourceContainer(
      this.dap,
      sourceMapCache,
      rootPath,
      sourcePathResolver,
      sourceMapRepo,
      this._scriptSkipper,
    );
    this._scriptSkipper.setSourceContainer(this.sourceContainer);
    this.breakpointManager = new BreakpointManager(
      this.dap,
      this.sourceContainer,
      launchConfig.pauseForSourceMap,
      bpPredictor,
    );

    this._rawTelemetryReporter.onFlush(() => {
      this._rawTelemetryReporter.report(
        'breakpointStats',
        this.breakpointManager.statisticsForTelemetry(),
      );
    });
  }

  @logPerf()
  public async launchBlocker(): Promise<void> {
    await this._configurationDoneDeferred.promise;
    await this.breakpointManager.launchBlocker();
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
        {
          filter: 'caught',
          label: localize('breakpoint.caughtExceptions', 'Caught Exceptions'),
          default: false,
        },
        {
          filter: 'uncaught',
          label: localize('breakpoint.uncaughtExceptions', 'Uncaught Exceptions'),
          default: false,
        },
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
      supportsValueFormattingOptions: true,
      supportsExceptionInfoRequest: true,
      supportTerminateDebuggee: false,
      supportsDelayedStackTraceLoading: true,
      supportsLoadedSourcesRequest: true,
      supportsLogPoints: true,
      supportsTerminateThreadsRequest: false,
      supportsSetExpression: false,
      supportsTerminateRequest: false,
      completionTriggerCharacters: ['.', '[', '"', "'"],
      supportsBreakpointLocationsRequest: true,
      //supportsDataBreakpoints: false,
      //supportsReadMemoryRequest: false,
      //supportsDisassembleRequest: false,
    };
  }

  async _onSetBreakpoints(
    params: Dap.SetBreakpointsParams,
  ): Promise<Dap.SetBreakpointsResult | Dap.Error> {
    const ids = generateBreakpointIds(params);
    return this.breakpointManager.setBreakpoints(params, ids);
  }

  async setExceptionBreakpoints(
    params: Dap.SetExceptionBreakpointsParams,
  ): Promise<Dap.SetExceptionBreakpointsResult> {
    this._pauseOnExceptionsState = 'none';
    if (params.filters.includes('caught')) this._pauseOnExceptionsState = 'all';
    else if (params.filters.includes('uncaught')) this._pauseOnExceptionsState = 'uncaught';
    if (this._thread) await this._thread.setPauseOnExceptionsState(this._pauseOnExceptionsState);
    return {};
  }

  async configurationDone(): Promise<Dap.ConfigurationDoneResult> {
    this._configurationDoneDeferred.resolve();
    return {};
  }

  async _onLoadedSources(): Promise<Dap.LoadedSourcesResult> {
    return { sources: await this.sourceContainer.loadedSources() };
  }

  async _onSource(params: Dap.SourceParams): Promise<Dap.SourceResult | Dap.Error> {
    if (!params.source) {
      return errors.createSilentError(localize('error.sourceNotFound', 'Source not found'));
    }

    params.source.path = urlUtils.platformPathToPreferredCase(params.source.path);
    const source = this.sourceContainer.source(params.source);
    if (!source)
      return errors.createSilentError(localize('error.sourceNotFound', 'Source not found'));
    const content = await source.content();
    if (content === undefined)
      return errors.createSilentError(
        localize('error.sourceContentDidFail', 'Unable to retrieve source content'),
      );
    return { content, mimeType: source.mimeType() };
  }

  async _onThreads(): Promise<Dap.ThreadsResult | Dap.Error> {
    const threads: Dap.Thread[] = [];
    if (this._thread) threads.push({ id: this._thread.id, name: this._thread.name() });
    return { threads };
  }

  async _onStackTrace(params: Dap.StackTraceParams): Promise<Dap.StackTraceResult | Dap.Error> {
    if (!this._thread) return this._threadNotAvailableError();
    return this._thread.stackTrace(params);
  }

  _findVariableStore(variablesReference: number): VariableStore | undefined {
    if (!this._thread) return;

    const pausedVariables = this._thread.pausedVariables();
    if (pausedVariables?.hasVariables(variablesReference)) return pausedVariables;
    if (this._thread.replVariables.hasVariables(variablesReference))
      return this._thread.replVariables;
  }

  async _onVariables(params: Dap.VariablesParams): Promise<Dap.VariablesResult> {
    const variableStore = this._findVariableStore(params.variablesReference);
    if (!variableStore) return { variables: [] };
    return { variables: await variableStore.getVariables(params) };
  }

  async _onSetVariable(params: Dap.SetVariableParams): Promise<Dap.SetVariableResult | Dap.Error> {
    const variableStore = this._findVariableStore(params.variablesReference);
    if (!variableStore)
      return errors.createSilentError(localize('error.variableNotFound', 'Variable not found'));
    params.value = sourceUtils.wrapObjectLiteral(params.value.trim());
    return variableStore.setVariable(params);
  }

  _withThread<T>(callback: (thread: Thread) => Promise<T>): Promise<T | Dap.Error> {
    if (!this._thread) return Promise.resolve(this._threadNotAvailableError());
    return callback(this._thread);
  }

  async _refreshStackTrace() {
    if (!this._thread) return;
    const details = this._thread.pausedDetails();
    if (details) await this._thread.refreshStackTrace();
  }

  _threadNotAvailableError(): Dap.Error {
    return errors.createSilentError(localize('error.threadNotFound', 'Thread not found'));
  }

  createThread(threadName: string, cdp: Cdp.Api, delegate: IThreadDelegate): Thread {
    this._thread = new Thread(
      this.sourceContainer,
      threadName,
      cdp,
      this.dap,
      delegate,
      this.launchConfig,
      this.breakpointManager,
    );
    for (const breakpoint of this._customBreakpoints)
      this._thread.updateCustomBreakpoint(breakpoint, true);

    this.asyncStackPolicy
      .connect(cdp)
      .then(d => this._disposables.push(d))
      .catch(err => logger.error(LogTag.Internal, 'Error enabling async stacks', err));

    this._thread.setPauseOnExceptionsState(this._pauseOnExceptionsState);
    this.breakpointManager.setThread(this._thread);
    return this._thread;
  }

  async enableCustomBreakpoints(
    params: Dap.EnableCustomBreakpointsParams,
  ): Promise<Dap.EnableCustomBreakpointsResult> {
    const promises: Promise<void>[] = [];
    for (const id of params.ids) {
      this._customBreakpoints.add(id);
      if (this._thread) promises.push(this._thread.updateCustomBreakpoint(id, true));
    }
    await Promise.all(promises);
    return {};
  }

  async _disableCustomBreakpoints(
    params: Dap.DisableCustomBreakpointsParams,
  ): Promise<Dap.DisableCustomBreakpointsResult> {
    const promises: Promise<void>[] = [];
    for (const id of params.ids) {
      this._customBreakpoints.delete(id);
      if (this._thread) promises.push(this._thread.updateCustomBreakpoint(id, false));
    }
    await Promise.all(promises);
    return {};
  }

  async _toggleSkipFileStatus(
    params: Dap.ToggleSkipFileStatusParams,
  ): Promise<Dap.ToggleSkipFileStatusResult | Dap.Error> {
    await this._scriptSkipper.toggleSkippingFile(params);
    await this._refreshStackTrace();
    return {};
  }

  async _canPrettyPrintSource(
    params: Dap.CanPrettyPrintSourceParams,
  ): Promise<Dap.CanPrettyPrintSourceResult | Dap.Error> {
    if (!params.source) {
      return { canPrettyPrint: false };
    }

    params.source.path = urlUtils.platformPathToPreferredCase(params.source.path);
    const source = this.sourceContainer.source(params.source);
    if (!source)
      return errors.createSilentError(localize('error.sourceNotFound', 'Source not found'));
    return { canPrettyPrint: source.canPrettyPrint() };
  }

  async _prettyPrintSource(
    params: Dap.PrettyPrintSourceParams,
  ): Promise<Dap.PrettyPrintSourceResult | Dap.Error> {
    if (!params.source) {
      return { canPrettyPrint: false };
    }

    params.source.path = urlUtils.platformPathToPreferredCase(params.source.path);
    const source = this.sourceContainer.source(params.source);
    if (!source)
      return errors.createSilentError(localize('error.sourceNotFound', 'Source not found'));

    if (!source.canPrettyPrint() || !(await source.prettyPrint()))
      return errors.createSilentError(
        localize('error.cannotPrettyPrint', 'Unable to pretty print'),
      );

    await this._refreshStackTrace();
    if (params.line) {
      const originalUiLocation: IUiLocation = {
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
    this._disposables.dispose();
  }
}
