/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Container } from 'inversify';
import * as nls from 'vscode-nls';
import { Cdp } from '../cdp/api';
import { DisposableList, IDisposable } from '../common/disposable';
import { ILogger, LogTag } from '../common/logging';
import { getDeferred, IDeferred } from '../common/promiseUtil';
import { IRenameProvider } from '../common/sourceMaps/renameProvider';
import * as sourceUtils from '../common/sourceUtils';
import * as urlUtils from '../common/urlUtils';
import { AnyLaunchConfiguration } from '../configuration';
import Dap from '../dap/api';
import * as errors from '../dap/errors';
import { disposeContainer } from '../ioc-extras';
import { ITelemetryReporter } from '../telemetry/telemetryReporter';
import { IAsyncStackPolicy } from './asyncStackPolicy';
import { BreakpointManager } from './breakpoints';
import { ICdpProxyProvider } from './cdpProxy';
import { ICompletions } from './completions';
import { IConsole } from './console';
import { Diagnostics } from './diagnosics';
import { DiagnosticToolSuggester } from './diagnosticToolSuggester';
import { IEvaluator } from './evaluator';
import { IExceptionPauseService, PauseOnExceptionsState } from './exceptionPauseService';
import { IPerformanceProvider } from './performance';
import { IProfileController } from './profileController';
import { BasicCpuProfiler } from './profiling/basicCpuProfiler';
import { ScriptSkipper } from './scriptSkipper/implementation';
import { IScriptSkipper } from './scriptSkipper/scriptSkipper';
import { ISourceWithMap, SourceContainer, SourceFromMap } from './sources';
import { IThreadDelegate, Thread } from './threads';
import { VariableStore } from './variables';

const localize = nls.loadMessageBundle();

// This class collects configuration issued before "launch" request,
// to be applied after launch.
export class DebugAdapter implements IDisposable {
  readonly dap: Dap.Api;
  readonly sourceContainer: SourceContainer;
  readonly breakpointManager: BreakpointManager;
  private _disposables = new DisposableList();
  private _customBreakpoints = new Set<string>();
  private _thread: Thread | undefined;
  private _configurationDoneDeferred: IDeferred<void>;
  private lastBreakpointId = 0;

  constructor(
    dap: Dap.Api,
    private readonly asyncStackPolicy: IAsyncStackPolicy,
    private readonly launchConfig: AnyLaunchConfiguration,
    private readonly _services: Container,
  ) {
    this._configurationDoneDeferred = getDeferred();

    this.sourceContainer = _services.get(SourceContainer);

    // It seems that the _onSetBreakpoints callback might be called while this method is being executed
    // so we initialize this before configuring the event handlers for the dap
    this.breakpointManager = _services.get(BreakpointManager);

    const performanceProvider = _services.get<IPerformanceProvider>(IPerformanceProvider);
    const telemetry = _services.get<ITelemetryReporter>(ITelemetryReporter);
    telemetry.onFlush(() => {
      telemetry.report('breakpointStats', this.breakpointManager.statisticsForTelemetry());
      telemetry.report('statistics', this.sourceContainer.statistics());
    });

    this.dap = dap;
    this.dap.on('initialize', params => this._onInitialize(params));
    this.dap.on('setBreakpoints', params => this._onSetBreakpoints(params));
    this.dap.on('setExceptionBreakpoints', params => this.setExceptionBreakpoints(params));
    this.dap.on('configurationDone', () => this.configurationDone());
    this.dap.on('loadedSources', () => this._onLoadedSources());
    this.dap.on('disableSourcemap', params => this._onDisableSourcemap(params));
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
    this.dap.on('revealPage', () => this._withThread(thread => thread.revealPage()));
    this.dap.on('getPerformance', () =>
      this._withThread(thread => performanceProvider.retrieve(thread.cdp())),
    );
    this.dap.on('breakpointLocations', params =>
      this._withThread(async thread => ({
        breakpoints: await this.breakpointManager.getBreakpointLocations(thread, params),
      })),
    );
    this.dap.on('createDiagnostics', params => this._dumpDiagnostics(params));
    this.dap.on('requestCDPProxy', () => this._requestCDPProxy());
  }

  public async launchBlocker(): Promise<void> {
    await this._configurationDoneDeferred.promise;
    await this._services.get<IExceptionPauseService>(IExceptionPauseService).launchBlocker;
    await this.breakpointManager.launchBlocker();
  }

  async _onInitialize(params: Dap.InitializeParams): Promise<Dap.InitializeResult | Dap.Error> {
    console.assert(params.linesStartAt1);
    console.assert(params.columnsStartAt1);
    const capabilities = DebugAdapter.capabilities();
    setTimeout(() => this.dap.initialized({}), 0);
    setTimeout(() => this._thread?.dapInitialized(), 0);
    return capabilities;
  }

  static capabilities(): Dap.Capabilities {
    return {
      supportsConfigurationDoneRequest: true,
      supportsFunctionBreakpoints: false,
      supportsConditionalBreakpoints: true,
      supportsHitConditionalBreakpoints: true,
      supportsEvaluateForHovers: true,
      exceptionBreakpointFilters: [
        {
          filter: PauseOnExceptionsState.All,
          label: localize('breakpoint.caughtExceptions', 'Caught Exceptions'),
          default: false,
          supportsCondition: true,
          description: localize(
            'breakpoint.caughtExceptions.description',
            "Breaks on all throw errors, even if they're caught later.",
          ),
          conditionDescription: `error.name == "MyError"`,
        },
        {
          filter: PauseOnExceptionsState.Uncaught,
          label: localize('breakpoint.uncaughtExceptions', 'Uncaught Exceptions'),
          default: false,
          supportsCondition: true,
          description: localize(
            'breakpoint.caughtExceptions.description',
            'Breaks only on errors or promise rejections that are not handled.',
          ),
          conditionDescription: `error.name == "MyError"`,
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
      supportsClipboardContext: true,
      supportsExceptionFilterOptions: true,
      //supportsDataBreakpoints: false,
      //supportsReadMemoryRequest: false,
      //supportsDisassembleRequest: false,
    };
  }

  private async _onSetBreakpoints(
    params: Dap.SetBreakpointsParams,
  ): Promise<Dap.SetBreakpointsResult | Dap.Error> {
    return this.breakpointManager.setBreakpoints(
      params,
      params.breakpoints?.map(() => ++this.lastBreakpointId) ?? [],
    );
  }

  async setExceptionBreakpoints(
    params: Dap.SetExceptionBreakpointsParams,
  ): Promise<Dap.SetExceptionBreakpointsResult> {
    await this._services.get<IExceptionPauseService>(IExceptionPauseService).setBreakpoints(params);
    return {};
  }

  async configurationDone(): Promise<Dap.ConfigurationDoneResult> {
    this._configurationDoneDeferred.resolve();
    return {};
  }

  async _onLoadedSources(): Promise<Dap.LoadedSourcesResult> {
    return { sources: await this.sourceContainer.loadedSources() };
  }

  private async _onDisableSourcemap(params: Dap.DisableSourcemapParams) {
    const source = this.sourceContainer.source(params.source);
    if (!source) {
      return errors.createSilentError(localize('error.sourceNotFound', 'Source not found'));
    }

    if (!(source instanceof SourceFromMap)) {
      return errors.createSilentError(localize('error.sourceNotFound', 'Source not a source map'));
    }

    for (const compiled of source.compiledToSourceUrl.keys()) {
      this.sourceContainer.disableSourceMapForSource(compiled, /* permanent= */ true);
    }

    await this._thread?.refreshStackTrace();

    return {};
  }

  async _onSource(params: Dap.SourceParams): Promise<Dap.SourceResult | Dap.Error> {
    if (!params.source) {
      params.source = { sourceReference: params.sourceReference };
    }

    params.source.path = urlUtils.platformPathToPreferredCase(params.source.path);
    const source = this.sourceContainer.source(params.source);
    if (!source) {
      return errors.createSilentError(localize('error.sourceNotFound', 'Source not found'));
    }

    const content = await source.content();
    if (content === undefined) {
      if (source instanceof SourceFromMap) {
        this.dap.suggestDisableSourcemap({ source: params.source });
      }

      return errors.createSilentError(
        localize('error.sourceContentDidFail', 'Unable to retrieve source content'),
      );
    }

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

  createThread(
    cdp: Cdp.Api,
    delegate: IThreadDelegate,
    initializeParams?: Dap.InitializeParams,
  ): Thread {
    this._thread = new Thread(
      this.sourceContainer,
      cdp,
      this.dap,
      delegate,
      this._services.get(IRenameProvider),
      this._services.get(ILogger),
      this._services.get(IEvaluator),
      this._services.get(ICompletions),
      this.launchConfig,
      this.breakpointManager,
      this._services.get(IConsole),
      this._services.get(IExceptionPauseService),
    );
    if (initializeParams) {
      // We won't get notified of an initialize message:
      // that was already caught by the caller.
      setTimeout(() => {
        this._onInitialize(initializeParams);
      }, 0);
    }

    const profile = this._services.get<IProfileController>(IProfileController);
    profile.connect(this.dap, this._thread);
    if ('profileStartup' in this.launchConfig && this.launchConfig.profileStartup) {
      profile.start(this.dap, this._thread, { type: BasicCpuProfiler.type });
    }

    for (const breakpoint of this._customBreakpoints)
      this._thread.updateCustomBreakpoint(breakpoint, true);

    this.asyncStackPolicy
      .connect(cdp)
      .then(d => this._disposables.push(d))
      .catch(err =>
        this._services
          .get<ILogger>(ILogger)
          .error(LogTag.Internal, 'Error enabling async stacks', err),
      );

    this.breakpointManager.setThread(this._thread);
    this._services.get(DiagnosticToolSuggester).attach(cdp);

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
    await this._services.get<ScriptSkipper>(IScriptSkipper).toggleSkippingFile(params);
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
    if (!source) {
      return errors.createSilentError(localize('error.sourceNotFound', 'Source not found'));
    }

    const prettified = await source.prettyPrint();
    if (!prettified) {
      return errors.createSilentError(
        localize('error.cannotPrettyPrint', 'Unable to pretty print'),
      );
    }

    const { map: sourceMap, source: generated } = prettified;

    this.breakpointManager.moveBreakpoints(source, sourceMap, generated);
    this.sourceContainer.clearDisabledSourceMaps(source as ISourceWithMap);
    await this._refreshStackTrace();

    return {};
  }

  async _dumpDiagnostics(params: Dap.CreateDiagnosticsParams) {
    const out = { file: await this._services.get(Diagnostics).generateHtml() };
    if (params.fromSuggestion) {
      this._services
        .get<ITelemetryReporter>(ITelemetryReporter)
        .report('diagnosticPrompt', { event: 'opened' });
    }

    return out;
  }

  public async _requestCDPProxy() {
    return await this._services.get<ICdpProxyProvider>(ICdpProxyProvider).proxy();
  }

  dispose() {
    this._disposables.dispose();
    disposeContainer(this._services);
  }
}
