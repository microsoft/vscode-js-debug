// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Dap from './dap/api';
import {Cdp, CdpApi} from './cdp/api';

import CdpConnection from './cdp/connection';
import {Target, TargetManager, TargetEvents} from './sdk/targetManager';
import findChrome from './chrome/findChrome';
import * as launcher from './chrome/launcher';
import {URL} from 'url';
import * as path from 'path';
import * as completionz from './sdk/completions';
import {Thread, ThreadEvents} from './sdk/thread';
import {VariableStore} from './sdk/variableStore';
import * as objectPreview from './sdk/objectPreview';
import {Source, SourceContainer} from './sdk/source';

let stackId = 0;

export interface LaunchParams extends Dap.LaunchParams {
  url: string;
  webRoot?: string;
}

export class Adapter {
  private _dap: Dap.Api;
  private _browser: CdpApi;
  private _sourceContainer: SourceContainer;
  private _targetManager: TargetManager;
  private _launchParams: LaunchParams;

  private _mainTarget: Target;
  private _threads: Map<number, Thread> = new Map();
  private _variableStore = new VariableStore();

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

    this._sourceContainer = new SourceContainer();
    this._targetManager = new TargetManager(connection, this._sourceContainer);
    this._targetManager.on(TargetEvents.TargetAttached, (target: Target) => {
      if (target.thread())
        this._onThreadCreated(target.thread());
    });
    this._targetManager.on(TargetEvents.TargetDetached, (target: Target) => {
      if (target.thread())
        this._onThreadDestroyed(target.thread());
    });
    this._browser = connection.browser();

    connection.on(CdpConnection.Events.Disconnected, () => this._dap.exited({exitCode: 0}));

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
      supportsDelayedStackTraceLoading: false,
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
    this._mainTarget = this._targetManager.mainTarget();
    if (!this._mainTarget)
      this._mainTarget = await new Promise(f => this._targetManager.once(TargetEvents.TargetAttached, f)) as Target;
    this._targetManager.on(TargetEvents.TargetDetached, (target: Target) => {
      if (target === this._mainTarget) {
        this._dap.terminated({});
      }
    });

    const onSource = (source: Source) => {
      this._dap.loadedSource({reason: 'new', source: this._sourceToDap(source)});
    };
    this._sourceContainer.on(SourceContainer.Events.SourceAdded, onSource);
    this._sourceContainer.sources().forEach(onSource);
    this._sourceContainer.on(SourceContainer.Events.SourcesRemoved, (sources: Source[]) => {
      for (const source of sources)
        this._dap.loadedSource({reason: 'removed', source: this._sourceToDap(source)});
    });
    return {};
  }

  _onThreadCreated(thread: Thread): void {
    console.assert(!this._threads.has(thread.threadId()));
    this._threads.set(thread.threadId(), thread);
    this._dap.thread({reason: 'started', threadId: thread.threadId()});

    const onPaused = () => {
      const details = thread.pausedDetails();
      this._dap.stopped({
        // TODO(dgozman): map reason
        reason: 'pause',
        description: details.reason,
        threadId: thread.threadId(),
        text: 'didPause.text',
        allThreadsStopped: false
      });
    };
    thread.on(ThreadEvents.ThreadPaused, onPaused);
    if (thread.pausedDetails())
      onPaused();

    thread.on(ThreadEvents.ThreadResumed, () => {
      this._dap.continued({threadId: thread.threadId()});
    });
    thread.on(ThreadEvents.ThreadConsoleMessage, ({thread, event}) => this._onConsoleMessage(thread, event));
  }

  _onThreadDestroyed(thread: Thread): void {
    this._threads.delete(thread.threadId());
    this._dap.thread({reason: 'exited', threadId: thread.threadId()});
  }

  async _onConsoleMessage(thread: Thread, event: Cdp.Runtime.ConsoleAPICalledEvent): Promise<void> {
    const tokens = [];
    for (let i = 0; i < event.args.length; ++i) {
      const arg = event.args[i];
      let output = objectPreview.previewRemoteObject(arg);
      if (i === 0 && output.startsWith(`'`) && output.endsWith(`'`))
        output = output.substring(1, output.length - 1);
      tokens.push(output);
    }

    const callFrame = event.stackTrace ? event.stackTrace.callFrames[0] : null;
    const location = callFrame ? this._sourceContainer.uiLocation({
      url: callFrame.url,
      lineNumber: callFrame.lineNumber,
      columnNumber: callFrame.columnNumber,
      source: thread.scripts().get(callFrame.scriptId)
    }) : null;

    let prefix = ''
    if (event.type === 'warning')
      prefix = '⚠️';
    if (event.type === 'error')
      prefix = '🔴';

    let category = 'stdout';
    if (event.type === 'error')
      category = 'stderr';
    if (event.type === 'warning')
      category = 'console';
    this._dap.output({
      category: category as any,
      output: prefix + tokens.join(' '),
      variablesReference: 0,
      line: location ? location.lineNumber : undefined,
      column: location ? location.columnNumber : undefined,
    });
  }

  async _onLaunch(params: LaunchParams): Promise<Dap.LaunchResult> {
    if (!this._mainTarget)
      await this._onConfigurationDone({});

    // params.noDebug
    this._launchParams = params;
    this._mainTarget.cdp().Page.navigate({url: this._launchParams.url});
    return {};
  }

  async _onTerminate(params: Dap.TerminateParams): Promise<Dap.TerminateResult> {
    this._mainTarget.cdp().Page.navigate({url: 'about:blank'});
    return {};
  }

  async _onDisconnect(params: Dap.DisconnectParams): Promise<Dap.DisconnectResult> {
    this._browser.Browser.close();
    return {};
  }

  async _onRestart(params: Dap.RestartParams): Promise<Dap.RestartResult> {
    this._mainTarget.cdp().Page.navigate({url: this._launchParams.url});
    return {};
  }

  async _onThreads(params: Dap.ThreadsParams): Promise<Dap.ThreadsResult> {
    const threads = [];
    for (const thread of this._threads.values())
      threads.push({id: thread.threadId(), name: thread.threadName()});
    return {threads};
  }

  async _onContinue(params: Dap.ContinueParams): Promise<Dap.ContinueResult> {
    const thread = this._threads.get(params.threadId);
    if (thread)
      thread.resume();
    return {allThreadsContinued: false};
  }

  async _onStackTrace(params: Dap.StackTraceParams): Promise<Dap.StackTraceResult> {
    const thread = this._threads.get(params.threadId);
    if (!thread || !thread.pausedDetails())
      return {stackFrames: [], totalFrames: 0};
    const details = thread.pausedDetails()!;
    const result: Dap.StackFrame[] = [];

    for (const callFrame of details.callFrames) {
      const location = this._sourceContainer.uiLocation({
        url: callFrame.url,
        lineNumber: callFrame.location.lineNumber,
        columnNumber: callFrame.location.columnNumber,
        source: thread.scripts().get(callFrame.location.scriptId)
      });
      const stackFrame: Dap.StackFrame = {
        id: ++stackId,
        name: callFrame.functionName || '<anonymous>',
        line: location.lineNumber + 1,
        column: location.columnNumber + 1,
        source: this._sourceToDap(location.source),
        presentationHint: 'normal'
      };
      result.push(stackFrame);
    }

    let asyncParent = details.asyncStackTrace;
    while (asyncParent) {
      if (asyncParent.description === 'async function' && asyncParent.callFrames.length)
        asyncParent.callFrames.shift();

      if (!asyncParent.callFrames.length) {
        asyncParent = asyncParent.parent;
        continue;
      }

      result.push({
        id: ++stackId,
        name: asyncParent.description || 'async',
        line: 1,
        column: 1,
        presentationHint: 'label'
      });

      for (const callFrame of asyncParent.callFrames) {
        const location = this._sourceContainer.uiLocation({
          url: callFrame.url,
          lineNumber: callFrame.lineNumber,
          columnNumber: callFrame.columnNumber,
          source: thread.scripts().get(callFrame.scriptId)
        });
        const stackFrame: Dap.StackFrame = {
          id: ++stackId,
          name: callFrame.functionName || '<anonymous>',
          line: location.lineNumber + 1,
          column: location.columnNumber + 1,
          source: this._sourceToDap(location.source),
          presentationHint: 'normal'
        };
        result.push(stackFrame);
      }
      asyncParent = asyncParent.parent;
    }

    return {stackFrames: result, totalFrames: result.length};
  }

  _sourceToDap(source: Source | undefined): Dap.Source {
    if (!source)
      return {name: 'unknown'};

    let rebased: string | undefined;
    const url = source.url();
    if (url && url.startsWith('file://')) {
      rebased = url.substring(7);
      // TODO(dgozman): what if absolute file url does not belong to webRoot?
    } else if (url && this._launchParams && this._launchParams.webRoot) {
      try {
        let relative = new URL(url).pathname;
        if (relative === '' || relative === '/')
          relative = 'index.html';
        rebased = path.join(this._launchParams.webRoot, relative);
      } catch (e) {
      }
    }
    // TODO(dgozman): can we check whether the path exists? Search for another match? Provide source fallback?
    return {
      name: path.basename(rebased || source.url() || '') || '<anonymous>',
      path: rebased,
      sourceReference: rebased ? 0 : source.sourceReference(),
      presentationHint: 'normal'
    };
  }

  async _onScopes(params: Dap.ScopesParams): Promise<Dap.ScopesResult> {
    return {scopes: []};
  }

  async _onVariables(params: Dap.VariablesParams): Promise<Dap.VariablesResult> {
    return {variables: await this._variableStore.getVariables(params)};
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
    const variable = await this._variableStore.createVariable(this._mainTarget.cdp(), response.result, args.context);
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
    return {sources: this._sourceContainer.sources().map(source => this._sourceToDap(source))};
  }

  async _onSource(params: Dap.SourceParams): Promise<Dap.SourceResult> {
    const source = this._sourceContainer.source(params.sourceReference);
    if (!source)
      return {content: '', mimeType: 'text/javascript'};
    return {content: await source.content(), mimeType: source.mimeType()};
  }

  async _onSetBreakpoints(params: Dap.SetBreakpointsParams): Promise<Dap.SetBreakpointsResult> {
    return {breakpoints: []};
  }
}
