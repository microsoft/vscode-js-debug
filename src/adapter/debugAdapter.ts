/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { Container } from 'inversify';
import { Cdp } from '../cdp/api';
import { DisposableList, IDisposable } from '../common/disposable';
import { ILogger, LogTag } from '../common/logging';
import { posInt32Counter, truthy } from '../common/objUtils';
import { Base1Position } from '../common/positions';
import { getDeferred, IDeferred } from '../common/promiseUtil';
import { IRenameProvider } from '../common/sourceMaps/renameProvider';
import * as sourceUtils from '../common/sourceUtils';
import * as urlUtils from '../common/urlUtils';
import { AnyLaunchConfiguration } from '../configuration';
import Dap from '../dap/api';
import * as errors from '../dap/errors';
import { ProtocolError } from '../dap/protocolError';
import { disposeContainer, FS, FsPromises } from '../ioc-extras';
import { ITarget } from '../targets/targets';
import { ITelemetryReporter } from '../telemetry/telemetryReporter';
import { IShutdownParticipants } from '../ui/shutdownParticipants';
import { IAsyncStackPolicy } from './asyncStackPolicy';
import { BreakpointManager } from './breakpoints';
import { ICdpProxyProvider } from './cdpProxy';
import { IClientCapabilies } from './clientCapabilities';
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
import { SmartStepper } from './smartStepping';
import { ISourceWithMap, SourceFromMap } from './source';
import { SourceContainer } from './sourceContainer';
import { Thread } from './threads';
import { VariableStore } from './variableStore';

// This class collects configuration issued before "launch" request,
// to be applied after launch.
export class DebugAdapter implements IDisposable {
  readonly dap: Dap.Api;
  readonly sourceContainer: SourceContainer;
  readonly breakpointManager: BreakpointManager;
  private _disposables = new DisposableList();
  private _customBreakpoints: string[] = [];
  private _xhrBreakpoints: string[] = [];
  private _thread: Thread | undefined;
  private _threadDeferred = getDeferred<Thread>();
  private _configurationDoneDeferred: IDeferred<void>;
  private breakpointIdCounter = posInt32Counter();
  private readonly _cdpProxyProvider = this._services.get<ICdpProxyProvider>(ICdpProxyProvider);

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
    this.dap.on('initialize', params => this.onInitialize(params));
    this.dap.on('setBreakpoints', params => this._onSetBreakpoints(params));
    this.dap.on('setExceptionBreakpoints', params => this.setExceptionBreakpoints(params));
    this.dap.on('configurationDone', () => this.configurationDone());
    this.dap.on('loadedSources', () => this._onLoadedSources());
    this.dap.on('disableSourcemap', params => this._onDisableSourcemap(params));
    this.dap.on('source', params => this._onSource(params));
    this.dap.on('threads', () => this._onThreads());
    this.dap.on('stackTrace', params => this._withThread(thread => thread.stackTrace(params)));
    this.dap.on('variables', params => this._onVariables(params));
    this.dap.on('readMemory', params => this._onReadMemory(params));
    this.dap.on('writeMemory', params => this._onWriteMemory(params));
    this.dap.on('setVariable', params => this._onSetVariable(params));
    this.dap.on('setExpression', params => this._onSetExpression(params));
    this.dap.on('continue', () => this._withThread(thread => thread.resume()));
    this.dap.on('pause', () => this._withThread(thread => thread.pause()));
    this.dap.on('next', () => this._withThread(thread => thread.stepOver()));
    this.dap.on('stepIn', params => this._withThread(thread => thread.stepInto(params.targetId)));
    this.dap.on('stepOut', () => this._withThread(thread => thread.stepOut()));
    this.dap.on(
      'restartFrame',
      params => this._withThread(thread => thread.restartFrame(params)),
    );
    this.dap.on('scopes', params => this._withThread(thread => thread.scopes(params)));
    this.dap.on('evaluate', params => this.onEvaluate(params));
    this.dap.on('completions', params => this._withThread(thread => thread.completions(params)));
    this.dap.on('exceptionInfo', () => this._withThread(thread => thread.exceptionInfo()));
    this.dap.on('setCustomBreakpoints', params => this.setCustomBreakpoints(params));
    this.dap.on('toggleSkipFileStatus', params => this._toggleSkipFileStatus(params));
    this.dap.on('toggleSkipFileStatus', params => this._toggleSkipFileStatus(params));
    this.dap.on('prettyPrintSource', params => this._prettyPrintSource(params));
    this.dap.on('locations', params => this._onLocations(params));
    this.dap.on('revealPage', () => this._withThread(thread => thread.revealPage()));
    this.dap.on(
      'getPerformance',
      () => this._withThread(thread => performanceProvider.retrieve(thread.cdp())),
    );
    this.dap.on('breakpointLocations', params => this._breakpointLocations(params));
    this.dap.on('createDiagnostics', params => this._dumpDiagnostics(params));
    this.dap.on('requestCDPProxy', () => this._requestCDPProxy());
    this.dap.on('setExcludedCallers', params => this._onSetExcludedCallers(params));
    this.dap.on('saveDiagnosticLogs', ({ toFile }) => this._saveDiagnosticLogs(toFile));
    this.dap.on('setSourceMapStepping', params => this._setSourceMapStepping(params));
    this.dap.on('stepInTargets', params => this._stepInTargets(params));
    this.dap.on('setDebuggerProperty', params => this._setDebuggerProperty(params));
    this.dap.on('setSymbolOptions', params => this._setSymbolOptions(params));
    this.dap.on('networkCall', params => this._doNetworkCall(params));
    this.dap.on('enableNetworking', params => this._withThread(t => t.enableNetworking(params)));
    this.dap.on(
      'getPreferredUILocation',
      params => this._getPreferredUILocation(params),
    );
  }

  private async _getPreferredUILocation(
    params: Dap.GetPreferredUILocationParams,
  ): Promise<Dap.GetPreferredUILocationResult> {
    const source = this.sourceContainer.source(params.source);
    if (!source) {
      return params;
    }

    const location = await this.sourceContainer.preferredUiLocation({
      columnNumber: params.column + 1,
      lineNumber: params.line + 1,
      source,
    });

    return {
      column: location.columnNumber - 1,
      line: location.lineNumber - 1,
      source: await location.source.toDap(),
    };
  }

  private async _doNetworkCall({ method, params }: Dap.NetworkCallParams) {
    if (!this._thread) {
      return Promise.resolve({});
    }

    // ugly casts :(
    const networkDomain = this._thread.cdp().Network as unknown as Record<
      string,
      (method: unknown) => Promise<object>
    >;

    return networkDomain[method](params);
  }

  private _setDebuggerProperty(
    params: Dap.SetDebuggerPropertyParams,
  ): Promise<Dap.SetDebuggerPropertyResult> {
    this._thread?.cdp().DotnetDebugger.setDebuggerProperty(params);
    return Promise.resolve({});
  }

  private _setSymbolOptions(
    params: Dap.SetSymbolOptionsParams,
  ): Promise<Dap.SetSymbolOptionsResult> {
    this._thread?.cdp().DotnetDebugger.setSymbolOptions(params);
    return Promise.resolve({});
  }

  private _breakpointLocations(
    params: Dap.BreakpointLocationsParams,
  ): Promise<Dap.BreakpointLocationsResult> {
    return this._withThread(async thread => {
      const source = this.sourceContainer.source(params.source);
      if (!source) {
        return { breakpoints: [] };
      }

      const possibleBps = await this.breakpointManager.getBreakpointLocations(
        thread,
        source,
        new Base1Position(params.line, params.column || 1),
        new Base1Position(
          params.endLine || params.line + 1,
          params.endColumn || params.column || 1,
        ),
      );

      return {
        breakpoints: possibleBps
          .map(bp => bp.uiLocations.find(l => l.source === source))
          .filter(truthy)
          .map(bp => ({ line: bp.lineNumber, column: bp.columnNumber })),
      };
    });
  }

  private _stepInTargets(params: Dap.StepInTargetsParams): Promise<Dap.StepInTargetsResult> {
    return this._withThread(async thread => ({
      targets: await thread.getStepInTargets(params.frameId),
    }));
  }

  private _setSourceMapStepping({
    enabled,
  }: Dap.SetSourceMapSteppingParams): Promise<Dap.SetSourceMapSteppingResult> {
    this.sourceContainer.doSourceMappedStepping = enabled;
    return Promise.resolve({});
  }

  private async _saveDiagnosticLogs(toFile: string): Promise<Dap.SaveDiagnosticLogsResult> {
    const logs = this._services.get<ILogger>(ILogger).getRecentLogs();
    await this._services
      .get<FsPromises>(FS)
      .writeFile(toFile, logs.map(l => JSON.stringify(l)).join('\n'));
    return {};
  }

  public async launchBlocker(): Promise<void> {
    await this._configurationDoneDeferred.promise;
    await this._thread?.debuggerReady.promise;
    await this._services.get<IExceptionPauseService>(IExceptionPauseService).launchBlocker;
    await this.breakpointManager.launchBlocker();
  }

  async _onSetExcludedCallers({
    callers,
  }: Dap.SetExcludedCallersParams): Promise<Dap.SetExcludedCallersResult> {
    const thread = await this._threadDeferred.promise;
    thread.setExcludedCallers(callers);
    return {};
  }

  public async onInitialize(
    params: Dap.InitializeParams,
  ): Promise<Dap.InitializeResult | Dap.Error> {
    console.assert(params.linesStartAt1);
    console.assert(params.columnsStartAt1);
    this._services.get<IClientCapabilies>(IClientCapabilies).value = params;
    const capabilities = DebugAdapter.capabilities(true);
    setTimeout(() => this.dap.initialized({}), 0);
    setTimeout(() => this._thread?.dapInitialized(), 0);
    return capabilities;
  }

  static capabilities(extended = false): Dap.CapabilitiesExtended {
    return {
      supportsConfigurationDoneRequest: true,
      supportsFunctionBreakpoints: false,
      supportsConditionalBreakpoints: true,
      supportsHitConditionalBreakpoints: true,
      supportsEvaluateForHovers: true,
      supportsReadMemoryRequest: true,
      supportsWriteMemoryRequest: true,
      exceptionBreakpointFilters: [
        {
          filter: PauseOnExceptionsState.All,
          label: l10n.t('Caught Exceptions'),
          default: false,
          supportsCondition: true,
          description: l10n.t("Breaks on all throw errors, even if they're caught later."),
          conditionDescription: `error.name == "MyError"`,
        },
        {
          filter: PauseOnExceptionsState.Uncaught,
          label: l10n.t('Uncaught Exceptions'),
          default: false,
          supportsCondition: true,
          description: l10n.t('Breaks only on errors or promise rejections that are not handled.'),
          conditionDescription: `error.name == "MyError"`,
        },
      ],
      supportsStepBack: false,
      supportsSetVariable: true,
      supportsRestartFrame: true,
      supportsGotoTargetsRequest: false,
      supportsStepInTargetsRequest: true,
      supportsCompletionsRequest: true,
      supportsModulesRequest: false,
      additionalModuleColumns: [],
      supportedChecksumAlgorithms: [],
      supportsRestartRequest: true,
      supportsExceptionOptions: false,
      supportsValueFormattingOptions: true,
      supportsExceptionInfoRequest: true,
      supportTerminateDebuggee: true,
      supportsDelayedStackTraceLoading: true,
      supportsLoadedSourcesRequest: true,
      supportsLogPoints: true,
      supportsTerminateThreadsRequest: false,
      supportsSetExpression: true,
      supportsTerminateRequest: false,
      completionTriggerCharacters: ['.', '[', '"', "'"],
      supportsBreakpointLocationsRequest: true,
      supportsClipboardContext: true,
      supportsExceptionFilterOptions: true,
      supportsEvaluationOptions: extended ? true : false,
      supportsDebuggerProperties: extended ? true : false,
      supportsSetSymbolOptions: extended ? true : false,
      supportsANSIStyling: true,
      // supportsDataBreakpoints: false,
      // supportsDisassembleRequest: false,
    };
  }

  private async _onSetBreakpoints(
    params: Dap.SetBreakpointsParams,
  ): Promise<Dap.SetBreakpointsResult | Dap.Error> {
    return this.breakpointManager.setBreakpoints(
      params,
      params.breakpoints?.map(() => this.breakpointIdCounter()) ?? [],
    );
  }

  async setExceptionBreakpoints(
    params: Dap.SetExceptionBreakpointsParams,
  ): Promise<Dap.SetExceptionBreakpointsResult> {
    await this._services.get<IExceptionPauseService>(IExceptionPauseService).setBreakpoints(
      params,
    );
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
      return errors.createSilentError(l10n.t('Source not found'));
    }

    if (!(source instanceof SourceFromMap)) {
      return errors.createSilentError(l10n.t('Source not a source map'));
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
      return errors.createSilentError(l10n.t('Source not found'));
    }

    const content = await source.content();
    if (content === undefined) {
      if (source instanceof SourceFromMap) {
        this.dap.suggestDisableSourcemap({ source: params.source });
      }

      return errors.createSilentError(l10n.t('Unable to retrieve source content'));
    }

    return { content, mimeType: source.getSuggestedMimeType };
  }

  async _onThreads(): Promise<Dap.ThreadsResult | Dap.Error> {
    const threads: Dap.Thread[] = [];
    if (this._thread) threads.push({ id: this._thread.id, name: this._thread.name() });
    return { threads };
  }

  private findVariableStore(fn: (store: VariableStore) => boolean) {
    if (!this._thread) {
      return undefined;
    }

    const pausedVariables = this._thread.pausedVariables();
    if (pausedVariables && fn(pausedVariables)) {
      return pausedVariables;
    }

    if (fn(this._thread.replVariables)) {
      return this._thread.replVariables;
    }

    return undefined;
  }

  async _onLocations(params: Dap.LocationsParams): Promise<Dap.LocationsResult> {
    const variableStore = this.findVariableStore(v => v.hasVariable(params.locationReference));
    if (!variableStore || !this._thread) throw errors.locationNotFound();
    const location = await variableStore.getLocations(params.locationReference);
    const uiLocation = await this._thread.rawLocationToUiLocationWithWaiting(
      this._thread.rawLocation(location),
    );
    if (!uiLocation) throw errors.locationNotFound();
    return {
      source: await uiLocation.source.toDap(),
      line: uiLocation.lineNumber,
      column: uiLocation.columnNumber,
    };
  }

  async _onVariables(params: Dap.VariablesParams): Promise<Dap.VariablesResult> {
    const variableStore = this.findVariableStore(v => v.hasVariable(params.variablesReference));
    return { variables: (await variableStore?.getVariables(params)) ?? [] };
  }

  async _onReadMemory(params: Dap.ReadMemoryParams): Promise<Dap.ReadMemoryResult> {
    const ref = params.memoryReference;
    const memory = await this.findVariableStore(v => v.hasMemory(ref))?.readMemory(
      ref,
      params.offset ?? 0,
      params.count,
    );
    if (!memory) {
      return { address: '0', unreadableBytes: params.count };
    }

    return {
      address: '0',
      data: memory.toString('base64'),
      unreadableBytes: params.count - memory.length,
    };
  }

  async _onWriteMemory(params: Dap.WriteMemoryParams): Promise<Dap.WriteMemoryResult> {
    const ref = params.memoryReference;
    const bytesWritten = await this.findVariableStore(v => v.hasMemory(ref))?.writeMemory(
      ref,
      params.offset ?? 0,
      Buffer.from(params.data, 'base64'),
    );
    return { bytesWritten };
  }

  async _onSetExpression(params: Dap.SetExpressionParams): Promise<Dap.SetExpressionResult> {
    if (!this._thread) {
      throw new ProtocolError(errors.threadNotAvailable());
    }

    const r = await this._thread.evaluate({
      expression: `${params.expression} = ${sourceUtils.wrapObjectLiteral(params.value)}`,
      context: 'repl',
      frameId: params.frameId,
    });

    return {
      value: r.result,
      variablesReference: r.variablesReference,
      indexedVariables: r.indexedVariables,
      namedVariables: r.namedVariables,
      presentationHint: r.presentationHint,
      type: r.type,
      memoryReference: r.memoryReference,
      valueLocationReference: r.valueLocationReference,
    };
  }

  async _onSetVariable(params: Dap.SetVariableParams): Promise<Dap.SetVariableResult | Dap.Error> {
    const variableStore = this.findVariableStore(v => v.hasVariable(params.variablesReference));
    if (!variableStore) return errors.createSilentError(l10n.t('Variable not found'));
    params.value = sourceUtils.wrapObjectLiteral(params.value.trim());
    return variableStore.setVariable(params);
  }

  _withThread<T>(callback: (thread: Thread) => Promise<T>): Promise<T> {
    if (!this._thread) {
      throw new ProtocolError(errors.threadNotAvailable());
    }

    return callback(this._thread);
  }

  async _refreshStackTrace() {
    if (!this._thread) return;
    const details = this._thread.pausedDetails();
    if (details) await this._thread.refreshStackTrace();
  }

  createThread(cdp: Cdp.Api, target: ITarget): Thread {
    this._thread = new Thread(
      this.sourceContainer,
      cdp,
      this.dap,
      target,
      this._services.get(IRenameProvider),
      this._services.get(ILogger),
      this._services.get(IEvaluator),
      this._services.get(ICompletions),
      this.launchConfig,
      this.breakpointManager,
      this._services.get(IConsole),
      this._services.get(IExceptionPauseService),
      this._services.get(SmartStepper),
      this._services.get(IShutdownParticipants),
      this._services.get(IClientCapabilies),
    );

    const profile = this._services.get<IProfileController>(IProfileController);
    profile.connect(this.dap, this._thread);
    if ('profileStartup' in this.launchConfig && this.launchConfig.profileStartup) {
      profile.start(this.dap, this._thread, { type: BasicCpuProfiler.type });
    }

    this._thread.updateCustomBreakpoints(this._xhrBreakpoints, this._customBreakpoints);

    this.asyncStackPolicy
      .connect(cdp)
      .then(d => this._disposables.push(d))
      .catch(err =>
        this._services
          .get<ILogger>(ILogger)
          .error(LogTag.Internal, 'Error enabling async stacks', err)
      );

    this.breakpointManager.setThread(this._thread);
    this._services.get(DiagnosticToolSuggester).attach(cdp);
    this._threadDeferred.resolve(this._thread);

    return this._thread;
  }

  async setCustomBreakpoints({
    ids,
    xhr,
  }: Dap.SetCustomBreakpointsParams): Promise<Dap.SetCustomBreakpointsResult> {
    await this._thread?.updateCustomBreakpoints(xhr, ids);
    this._customBreakpoints = ids;
    this._xhrBreakpoints = xhr;
    return {};
  }

  async _toggleSkipFileStatus(
    params: Dap.ToggleSkipFileStatusParams,
  ): Promise<Dap.ToggleSkipFileStatusResult | Dap.Error> {
    await this._services.get<ScriptSkipper>(IScriptSkipper).toggleSkippingFile(params);
    await this._refreshStackTrace();
    return {};
  }

  async _prettyPrintSource(
    params: Dap.PrettyPrintSourceParams,
  ): Promise<Dap.PrettyPrintSourceResult | Dap.Error> {
    if (!params.source || !this._thread) {
      return { canPrettyPrint: false };
    }

    params.source.path = urlUtils.platformPathToPreferredCase(params.source.path);
    const source = this.sourceContainer.source(params.source);
    if (!source) {
      return errors.createSilentError(l10n.t('Source not found'));
    }

    const prettified = await source.prettyPrint();
    if (!prettified) {
      return errors.createSilentError(l10n.t('Unable to pretty print'));
    }

    const { map: sourceMap, source: generated } = prettified;

    await this.breakpointManager.moveBreakpoints(this._thread, source, sourceMap, generated);
    this.sourceContainer.clearDisabledSourceMaps(source as ISourceWithMap);
    await this._refreshStackTrace();

    return {};
  }

  private onEvaluate(args: Dap.EvaluateParams): Promise<Dap.EvaluateResult> {
    // Rewrite the old ".scripts" command to the new diagnostic tool
    if (args.expression === '.scripts') {
      return this._dumpDiagnostics({ fromSuggestion: false })
        .then(this.dap.openDiagnosticTool)
        .then(() => ({ result: 'Opening diagnostic tool...', variablesReference: 0 }));
    } else {
      return this._withThread(thread => thread.evaluate(args));
    }
  }

  private async _dumpDiagnostics(params: Dap.CreateDiagnosticsParams) {
    const out = { file: await this._services.get(Diagnostics).generateHtml() };
    if (params.fromSuggestion) {
      this._services
        .get<ITelemetryReporter>(ITelemetryReporter)
        .report('diagnosticPrompt', { event: 'opened' });
    }

    return out;
  }

  public async _requestCDPProxy() {
    return await this._cdpProxyProvider.proxy();
  }

  dispose() {
    this._disposables.dispose();
    disposeContainer(this._services);
  }
}
