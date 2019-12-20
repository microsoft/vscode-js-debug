/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as nls from 'vscode-nls';
import Cdp from '../cdp/api';
import { delay, getDeferred } from '../common/promiseUtil';
import { InlineScriptOffset } from '../common/sourcePathResolver';
import * as sourceUtils from '../common/sourceUtils';
import * as urlUtils from '../common/urlUtils';
import { AnyLaunchConfiguration, OutputSource } from '../configuration';
import Dap from '../dap/api';
import * as errors from '../dap/errors';
import { BreakpointManager } from './breakpoints';
import * as completions from './completions';
import { CustomBreakpointId, customBreakpoints } from './customBreakpoints';
import * as messageFormat from './messageFormat';
import * as objectPreview from './objectPreview';
import { ScriptSkipper } from './scriptSkipper';
import { SmartStepper } from './smartStepping';
import {
  IPreferredUiLocation,
  rawToUiOffset,
  Source,
  SourceContainer,
  IUiLocation,
} from './sources';
import { StackFrame, StackTrace } from './stackTrace';
import { VariableStore, IVariableStoreDelegate } from './variables';
import { toStringForClipboard } from './templates/toStringForClipboard';
import { previewThis } from './templates/previewThis';

const localize = nls.loadMessageBundle();

export type PausedReason =
  | 'step'
  | 'breakpoint'
  | 'exception'
  | 'pause'
  | 'entry'
  | 'goto'
  | 'function breakpoint'
  | 'data breakpoint';

export interface IPausedDetails {
  thread: Thread;
  reason: PausedReason;
  description: string;
  stackTrace: StackTrace;
  hitBreakpoints?: string[];
  text?: string;
  exception?: Cdp.Runtime.RemoteObject;
}

export type PauseOnExceptionsState = 'none' | 'uncaught' | 'all';

export class ExecutionContext {
  readonly thread: Thread;
  readonly description: Cdp.Runtime.ExecutionContextDescription;

  constructor(thread: Thread, description: Cdp.Runtime.ExecutionContextDescription) {
    this.thread = thread;
    this.description = description;
  }

  isDefault(): boolean {
    return this.description.auxData && this.description.auxData['isDefault'];
  }
}

export type Script = { url: string; scriptId: string; hash: string; source: Source };

export interface IThreadDelegate {
  supportsCustomBreakpoints(): boolean;
  shouldCheckContentHash(): boolean;
  defaultScriptOffset(): InlineScriptOffset | undefined;
  scriptUrlToUrl(url: string): string;
  executionContextName(description: Cdp.Runtime.ExecutionContextDescription): string;
  skipFiles(): ScriptSkipper | undefined;
  initialize(): Promise<void>;
}

export type ScriptWithSourceMapHandler = (
  script: Script,
  sources: Source[],
) => Promise<{ remainPaused: boolean }>;
export type SourceMapDisabler = (hitBreakpoints: string[]) => Source[];

export type RawLocation = {
  url: string;
  lineNumber: number; // 1-based
  columnNumber: number; // 1-based
  scriptId?: Cdp.Runtime.ScriptId;
};

export class Thread implements IVariableStoreDelegate {
  private static _lastThreadId = 0;
  public readonly id: number;
  private _dap: Dap.Api;
  private _cdp: Cdp.Api;
  private _name: string;
  private _pausedDetails?: IPausedDetails;
  private _pausedVariables?: VariableStore;
  private _pausedForSourceMapScriptId?: string;
  private _scripts: Map<string, Script> = new Map();
  private _executionContexts: Map<number, ExecutionContext> = new Map();
  private _delegate: IThreadDelegate;
  readonly replVariables: VariableStore;
  private _sourceContainer: SourceContainer;
  private _serializedOutput: Promise<void>;
  private _pauseOnSourceMapBreakpointId?: Cdp.Debugger.BreakpointId;
  private _selectedContext: ExecutionContext | undefined;
  private _consoleIsDirty = false;
  static _allThreadsByDebuggerId = new Map<Cdp.Runtime.UniqueDebuggerId, Thread>();
  private _scriptWithSourceMapHandler?: ScriptWithSourceMapHandler;
  private _sourceMapDisabler?: SourceMapDisabler;
  // url => (hash => Source)
  private _scriptSources = new Map<string, Map<string, Source>>();
  private _sourceMapLoads = new Map<string, Promise<{ remainPaused: boolean }>>();
  private _smartStepper: SmartStepper;
  private _expectedPauseReason?: { reason: PausedReason; description?: string };
  private readonly _sourceScripts = new WeakMap<Source, Set<Script>>();
  private readonly _pausedDetailsEvent = new WeakMap<IPausedDetails, Cdp.Debugger.PausedEvent>();

  constructor(
    sourceContainer: SourceContainer,
    threadName: string,
    cdp: Cdp.Api,
    dap: Dap.Api,
    delegate: IThreadDelegate,
    private readonly launchConfig: AnyLaunchConfiguration,
    private readonly _breakpointManager: BreakpointManager,
    private readonly enableInstrumentationBp: boolean,
  ) {
    this._delegate = delegate;
    this._sourceContainer = sourceContainer;
    this._cdp = cdp;
    this._dap = dap;
    this._name = threadName;
    this.id = Thread._lastThreadId++;
    this.replVariables = new VariableStore(this._cdp, this);
    this._serializedOutput = Promise.resolve();
    this._smartStepper = new SmartStepper(this.launchConfig);
    this._initialize();
  }

  cdp(): Cdp.Api {
    return this._cdp;
  }

  name(): string {
    return this._name;
  }

  pausedDetails(): IPausedDetails | undefined {
    return this._pausedDetails;
  }

  pausedVariables(): VariableStore | undefined {
    return this._pausedVariables;
  }

  executionContexts(): ExecutionContext[] {
    return Array.from(this._executionContexts.values());
  }

  defaultExecutionContext(): ExecutionContext | undefined {
    for (const context of this._executionContexts.values()) {
      if (context.isDefault()) return context;
    }
  }

  defaultScriptOffset(): InlineScriptOffset | undefined {
    return this._delegate.defaultScriptOffset();
  }

  async resume(): Promise<Dap.ContinueResult | Dap.Error> {
    this._sourceContainer.clearDisabledSourceMaps();
    if (!(await this._cdp.Debugger.resume({})))
      return errors.createSilentError(localize('error.resumeDidFail', 'Unable to resume'));
    return { allThreadsContinued: false };
  }

  async pause(): Promise<Dap.PauseResult | Dap.Error> {
    if (await this._cdp.Debugger.pause({})) this._expectedPauseReason = { reason: 'pause' };
    else return errors.createSilentError(localize('error.pauseDidFail', 'Unable to pause'));
    return {};
  }

  async stepOver(): Promise<Dap.NextResult | Dap.Error> {
    if (await this._cdp.Debugger.stepOver({})) this._expectedPauseReason = { reason: 'step' };
    else return errors.createSilentError(localize('error.stepOverDidFail', 'Unable to step next'));
    return {};
  }

  async stepInto(): Promise<Dap.StepInResult | Dap.Error> {
    if (await this._cdp.Debugger.stepInto({ breakOnAsyncCall: true }))
      this._expectedPauseReason = { reason: 'step' };
    else return errors.createSilentError(localize('error.stepInDidFail', 'Unable to step in'));
    return {};
  }

  async stepOut(): Promise<Dap.StepOutResult | Dap.Error> {
    if (!(await this._cdp.Debugger.stepOut({})))
      return errors.createSilentError(localize('error.stepOutDidFail', 'Unable to step out'));
    return {};
  }

  _stackFrameNotFoundError(): Dap.Error {
    return errors.createSilentError(localize('error.stackFrameNotFound', 'Stack frame not found'));
  }

  _evaluateOnAsyncFrameError(): Dap.Error {
    return errors.createSilentError(
      localize('error.evaluateOnAsyncStackFrame', 'Unable to evaluate on async stack frame'),
    );
  }

  async restartFrame(params: Dap.RestartFrameParams): Promise<Dap.RestartFrameResult | Dap.Error> {
    const stackFrame = this._pausedDetails?.stackTrace.frame(params.frameId);
    if (!stackFrame) {
      return this._stackFrameNotFoundError();
    }

    const callFrameId = stackFrame.callFrameId();
    if (!callFrameId) {
      return errors.createUserError(
        localize('error.restartFrameAsync', 'Cannot restart asynchronous frame'),
      );
    }

    await this._cdp.Debugger.restartFrame({ callFrameId });
    this._expectedPauseReason = {
      reason: 'frame_entry' as PausedReason,
      description: localize('reason.description.restart', 'Paused on frame entry'),
    };
    await this._cdp.Debugger.stepInto({});
    return {};
  }

  async stackTrace(params: Dap.StackTraceParams): Promise<Dap.StackTraceResult | Dap.Error> {
    if (!this._pausedDetails)
      return errors.createSilentError(localize('error.threadNotPaused', 'Thread is not paused'));
    return this._pausedDetails.stackTrace.toDap(params);
  }

  async scopes(params: Dap.ScopesParams): Promise<Dap.ScopesResult | Dap.Error> {
    const stackFrame = this._pausedDetails
      ? this._pausedDetails.stackTrace.frame(params.frameId)
      : undefined;
    if (!stackFrame) return this._stackFrameNotFoundError();
    return stackFrame.scopes();
  }

  async exceptionInfo(): Promise<Dap.ExceptionInfoResult | Dap.Error> {
    const exception = this._pausedDetails && this._pausedDetails.exception;
    if (!exception)
      return errors.createSilentError(
        localize('error.threadNotPausedOnException', 'Thread is not paused on exception'),
      );
    const preview = objectPreview.previewException(exception);
    return {
      exceptionId: preview.title,
      breakMode: 'all',
      details: {
        stackTrace: preview.stackTrace,
        evaluateName: undefined, // This is not used by vscode.
      },
    };
  }

  async completions(params: Dap.CompletionsParams): Promise<Dap.CompletionsResult | Dap.Error> {
    let stackFrame: StackFrame | undefined;
    if (params.frameId !== undefined) {
      stackFrame = this._pausedDetails
        ? this._pausedDetails.stackTrace.frame(params.frameId)
        : undefined;
      if (!stackFrame) return this._stackFrameNotFoundError();
      if (!stackFrame.callFrameId()) return this._evaluateOnAsyncFrameError();
    }
    const contexts: Dap.CompletionItem[] = [];
    for (const c of this._executionContexts.values()) {
      const text = `cd ${this._delegate.executionContextName(c.description)}`;
      if (text.startsWith(params.text)) {
        contexts.push({ label: text, start: 0, length: params.text.length });
      }
    }
    if (
      params.line === 1 &&
      params.column === params.text.length + 1 &&
      params.text.startsWith('cd ')
    )
      return { targets: contexts };
    const line = params.line === undefined ? 0 : params.line - 1;
    const targets = await completions.completions({
      cdp: this._cdp,
      executionContextId: this._selectedContext ? this._selectedContext.description.id : undefined,
      stackFrame,
      expression: params.text,
      line,
      column: params.column,
    });
    if (
      params.line === 1 &&
      params.column === params.text.length + 1 &&
      'cd '.startsWith(params.text)
    )
      return { targets: contexts.concat(targets) };
    return { targets };
  }

  async evaluate(args: Dap.EvaluateParams): Promise<Dap.EvaluateResult | Dap.Error> {
    let callFrameId: Cdp.Debugger.CallFrameId | undefined;
    if (args.frameId !== undefined) {
      const stackFrame = this._pausedDetails
        ? this._pausedDetails.stackTrace.frame(args.frameId)
        : undefined;
      if (!stackFrame) return this._stackFrameNotFoundError();
      callFrameId = stackFrame.callFrameId();
      if (!callFrameId) return this._evaluateOnAsyncFrameError();
    }

    if (args.context === 'repl' && args.expression.startsWith('cd ')) {
      const contextName = args.expression.substring('cd '.length).trim();
      for (const ec of this._executionContexts.values()) {
        if (this._delegate.executionContextName(ec.description) === contextName) {
          this._selectedContext = ec;
          return {
            result: `[${contextName}]`,
            variablesReference: 0,
          };
        }
      }
    }
    // TODO: consider checking expression for side effects on hover.
    const params: Cdp.Runtime.EvaluateParams = {
      expression: args.expression,
      includeCommandLineAPI: true,
      objectGroup: 'console',
      generatePreview: true,
      timeout: args.context === 'hover' ? 500 : undefined,
    };
    if (args.context === 'repl') {
      params.expression = sourceUtils.wrapObjectLiteral(params.expression);
      if (params.expression.indexOf('await') !== -1) {
        const rewritten = sourceUtils.rewriteTopLevelAwait(params.expression);
        if (rewritten) {
          params.expression = rewritten;
          params.awaitPromise = true;
        }
      }
    }

    const responsePromise = callFrameId
      ? this._cdp.Debugger.evaluateOnCallFrame({ ...params, callFrameId })
      : this._cdp.Runtime.evaluate({
          ...params,
          contextId: this._selectedContext ? this._selectedContext.description.id : undefined,
        });

    // Report result for repl immediately so that the user could see the expression they entered.
    if (args.context === 'repl') {
      return await this._evaluateRepl(responsePromise);
    }

    const response = await responsePromise;
    if (!response)
      return errors.createSilentError(localize('error.evaluateDidFail', 'Unable to evaluate'));
    if (response.exceptionDetails) {
      let text = response.exceptionDetails.exception
        ? objectPreview.previewException(response.exceptionDetails.exception).title
        : response.exceptionDetails.text;
      if (!text.startsWith('Uncaught')) text = 'Uncaught ' + text;
      return errors.createSilentError(text);
    }

    const variableStore = callFrameId ? this._pausedVariables : this.replVariables;
    if (!variableStore) {
      return errors.createSilentError(localize('error.evaluateDidFail', 'Unable to evaluate'));
    }

    const variable = await variableStore.createVariable(response.result, args.context);
    return {
      type: response.result.type,
      result: variable.value,
      variablesReference: variable.variablesReference,
      namedVariables: variable.namedVariables,
      indexedVariables: variable.indexedVariables,
    };
  }

  async _evaluateRepl(
    responsePromise:
      | Promise<Cdp.Runtime.EvaluateResult | undefined>
      | Promise<Cdp.Debugger.EvaluateOnCallFrameResult | undefined>,
  ): Promise<Dap.EvaluateResult | Dap.Error> {
    const response = await responsePromise;
    if (!response) return { result: '', variablesReference: 0 };

    if (response.exceptionDetails) {
      const formattedException = await this._formatException(response.exceptionDetails);
      throw new errors.ExternalError(formattedException.output);
    } else {
      const contextName =
        this._selectedContext && this.defaultExecutionContext() !== this._selectedContext
          ? `\x1b[33m[${this._delegate.executionContextName(this._selectedContext.description)}] `
          : '';
      const resultVar = await this.replVariables.createVariable(response.result, 'repl');
      return {
        variablesReference: resultVar.variablesReference,
        result: `${contextName}${resultVar.value}`,
      };
    }
  }

  private _initialize() {
    this._cdp.Runtime.on('executionContextCreated', event => {
      this._executionContextCreated(event.context);
    });
    this._cdp.Runtime.on('executionContextDestroyed', event => {
      this._executionContextDestroyed(event.executionContextId);
    });
    this._cdp.Runtime.on('executionContextsCleared', () => {
      this._ensureDebuggerEnabledAndRefreshDebuggerId();
      this.replVariables.clear();
      this._executionContextsCleared();
      const slot = this._claimOutputSlot();
      slot(this._clearDebuggerConsole());
    });
    if (this.launchConfig.outputCapture === OutputSource.Console) {
      this._cdp.Runtime.on('consoleAPICalled', async event => {
        const slot = this._claimOutputSlot();
        slot(await this._onConsoleMessage(event));
      });
    }
    this._cdp.Runtime.on('exceptionThrown', async event => {
      const slot = this._claimOutputSlot();
      slot(await this._formatException(event.exceptionDetails));
    });
    this._cdp.Runtime.on('inspectRequested', event => {
      if (event.hints['copyToClipboard']) this._copyObjectToClipboard(event.object);
      else if (event.hints['queryObjects']) this._queryObjects(event.object);
      else this._revealObject(event.object);
    });
    this._cdp.Runtime.enable({});

    this._cdp.Debugger.on('paused', async event => this._onPaused(event));
    this._cdp.Debugger.on('resumed', () => this._onResumed());
    this._cdp.Debugger.on('scriptParsed', event => this._onScriptParsed(event));

    this._ensureDebuggerEnabledAndRefreshDebuggerId();
    this._delegate.initialize();
    this._cdp.Debugger.setAsyncCallStackDepth({ maxDepth: 32 });
    const scriptSkipper = this._delegate.skipFiles();
    if (scriptSkipper) {
      // Note: here we assume that source container does only have a single thread.
      this._sourceContainer.initializeScriptSkipper(scriptSkipper);
      scriptSkipper.setBlackboxSender(this._cdp.Debugger);
    }
    this._pauseOnScheduledAsyncCall();

    this._dap.thread({
      reason: 'started',
      threadId: this.id,
    });
  }

  async refreshStackTrace() {
    if (!this._pausedDetails) {
      return;
    }

    const event = this._pausedDetailsEvent.get(this._pausedDetails);
    if (event) {
      this._pausedDetails = this._createPausedDetails(event);
    }

    this._onThreadResumed();
    await this._onThreadPaused(this._pausedDetails);
  }

  // It is important to produce debug console output in the same order as it happens
  // in the debuggee. Since we process any output asynchronously (e.g. retrieviing object
  // properties or loading async stack frames), we ensure the correct order using "output slots".
  //
  // Any method producing output should claim a slot synchronously when receiving the cdp message
  // producing this output, then run any processing to generate the actual output and call the slot:
  //
  //   const response = await cdp.Runtime.evaluate(...);
  //   const slot = this._claimOutputSlot();
  //   const output = await doSomeAsyncProcessing(response);
  //   slot(output);
  //
  _claimOutputSlot(): (payload?: Dap.OutputEventParams) => void {
    // TODO: should we serialize output between threads? For example, it may be important
    // when using postMessage between page a worker.
    const slot = this._serializedOutput;
    const deferred = getDeferred<void>();
    const result = async (payload?: Dap.OutputEventParams) => {
      await slot;
      if (payload) {
        const isClearConsole = payload.output === '\x1b[2J';
        const noop = isClearConsole && !this._consoleIsDirty;
        if (!noop) {
          this._dap.output(payload);
          this._consoleIsDirty = !isClearConsole;
        }
      }
      deferred.resolve();
    };

    this._serializedOutput = slot.then(() => deferred.promise);
    // Timeout to avoid blocking future slots if this one does stall.
    setTimeout(deferred.resolve, this._sourceContainer.sourceMapTimeouts().output);

    return result;
  }

  async _pauseOnScheduledAsyncCall(): Promise<void> {
    if (!scheduledPauseOnAsyncCall) return;
    await this._cdp.Debugger.pauseOnAsyncCall({ parentStackTraceId: scheduledPauseOnAsyncCall });
  }

  _executionContextCreated(description: Cdp.Runtime.ExecutionContextDescription) {
    const context = new ExecutionContext(this, description);
    this._executionContexts.set(description.id, context);
  }

  _executionContextDestroyed(contextId: number) {
    const context = this._executionContexts.get(contextId);
    if (!context) return;
    this._executionContexts.delete(contextId);
  }

  _executionContextsCleared() {
    this._removeAllScripts();
    if (this._pausedDetails) this._onResumed();
    this._executionContexts.clear();
  }

  _ensureDebuggerEnabledAndRefreshDebuggerId() {
    // There is a bug in Chrome that does not retain debugger id
    // across cross-process navigations. Refresh it upon clearing contexts.
    this._cdp.Debugger.enable({}).then(response => {
      if (response) Thread._allThreadsByDebuggerId.set(response.debuggerId, this);
    });
  }

  private async _onPaused(event: Cdp.Debugger.PausedEvent) {
    if (event.reason === 'instrumentation' && event.data && event.data['scriptId']) {
      const remainPaused = await this._handleSourceMapPause(event.data['scriptId'] as string);

      if (
        scheduledPauseOnAsyncCall &&
        event.asyncStackTraceId &&
        scheduledPauseOnAsyncCall.debuggerId === event.asyncStackTraceId.debuggerId &&
        scheduledPauseOnAsyncCall.id === event.asyncStackTraceId.id
      ) {
        // Paused on the script which is run as a task for scheduled async call.
        // We are waiting for this pause, no need to resume.
      } else if (remainPaused) {
        // If should stay paused, that means the user set a breakpoint on
        // the first line (which we are already on!), so pretend it's
        // a breakpoint and let it bubble up.
        event.data.__rewriteAsBreakpoint = true;
      } else {
        await this._pauseOnScheduledAsyncCall();
        this.resume();
        return;
      }
    }

    if (event.asyncCallStackTraceId) {
      scheduledPauseOnAsyncCall = event.asyncCallStackTraceId;
      const threads = Array.from(Thread._allThreadsByDebuggerId.values());
      await Promise.all(threads.map(thread => thread._pauseOnScheduledAsyncCall()));
      this.resume();
      return;
    }

    this._pausedDetails = this._createPausedDetails(event);
    if (await this._smartStepper.shouldSmartStep(this._pausedDetails)) {
      this.stepInto();
      return;
    }

    if (this._pausedDetails.reason === 'breakpoint' && event.hitBreakpoints) {
      this._breakpointManager.notifyBreakpointHit(event.hitBreakpoints);
    }

    this._pausedDetailsEvent.set(this._pausedDetails, event);
    this._pausedVariables = new VariableStore(this._cdp, this);
    scheduledPauseOnAsyncCall = undefined;
    await this._onThreadPaused(this._pausedDetails);
  }

  _onResumed() {
    this._pausedDetails = undefined;
    this._pausedVariables = undefined;
    this._onThreadResumed();
  }

  dispose() {
    this._removeAllScripts();
    for (const [debuggerId, thread] of Thread._allThreadsByDebuggerId) {
      if (thread === this) Thread._allThreadsByDebuggerId.delete(debuggerId);
    }
    this._dap.thread({
      reason: 'exited',
      threadId: this.id,
    });

    this._executionContextsCleared();
  }

  rawLocation(
    location: Cdp.Runtime.CallFrame | Cdp.Debugger.CallFrame | Cdp.Debugger.Location,
  ): RawLocation {
    // Note: cdp locations are 0-based, while ui locations are 1-based.
    if ((location as Cdp.Debugger.CallFrame).location) {
      const loc = location as Cdp.Debugger.CallFrame;
      return {
        url: loc.url,
        lineNumber: loc.location.lineNumber + 1,
        columnNumber: (loc.location.columnNumber || 0) + 1,
        scriptId: loc.location.scriptId,
      };
    }
    const loc = location as Cdp.Debugger.Location | Cdp.Runtime.CallFrame;
    return {
      url: (loc as Cdp.Runtime.CallFrame).url || '',
      lineNumber: loc.lineNumber + 1,
      columnNumber: (loc.columnNumber || 0) + 1,
      scriptId: loc.scriptId,
    };
  }

  public async rawLocationToUiLocation(
    rawLocation: RawLocation,
  ): Promise<IPreferredUiLocation | undefined> {
    const script = rawLocation.scriptId
      ? await this.getScriptByIdOrWait(rawLocation.scriptId)
      : undefined;
    if (!script) {
      return;
    }

    const { lineNumber, columnNumber } = rawToUiOffset(rawLocation, this.defaultScriptOffset());
    return this._sourceContainer.preferredUiLocation({
      lineNumber,
      columnNumber,
      source: script.source,
    });
  }

  /**
   * Gets a script ID if it exists, or waits to up maxTime. In rare cases we
   * can get a request (like a stacktrace request) from DAP before Chrome
   * finishes passing its sources over. We *should* normally know about all
   * possible script IDs; this waits if we see one that we don't.
   */
  private async getScriptByIdOrWait(scriptId: string, maxTime = 500) {
    let script = this._scripts.get(scriptId);
    if (script) {
      return script;
    }

    const deadline = Date.now() + maxTime;
    do {
      await delay(50);
      script = this._scripts.get(scriptId);
    } while (!script && Date.now() < deadline);

    return script;
  }

  async renderDebuggerLocation(loc: Cdp.Debugger.Location): Promise<string> {
    const raw = this.rawLocation(loc);
    const ui = await this.rawLocationToUiLocation(raw);
    if (ui) return `@ ${await ui.source.prettyName()}:${ui.lineNumber}`;
    return `@ VM${raw.scriptId || 'XX'}:${raw.lineNumber}`;
  }

  async setPauseOnExceptionsState(state: PauseOnExceptionsState): Promise<void> {
    await this._cdp.Debugger.setPauseOnExceptions({ state });
  }

  async updateCustomBreakpoint(id: CustomBreakpointId, enabled: boolean): Promise<void> {
    if (!this._delegate.supportsCustomBreakpoints()) return;
    const breakpoint = customBreakpoints().get(id);
    if (!breakpoint) return;
    // Do not fail for custom breakpoints, to account for
    // future changes in cdp vs stale breakpoints saved in the workspace.
    await breakpoint.apply(this._cdp, enabled);
  }

  _createPausedDetails(event: Cdp.Debugger.PausedEvent): IPausedDetails {
    // When hitting breakpoint in compiled source, we ignore source maps during the stepping
    // sequence (or exceptions) until user resumes or hits another breakpoint-alike pause.
    // TODO: this does not work for async stepping just yet.
    const sameDebuggingSequence =
      event.reason === 'assert' ||
      event.reason === 'exception' ||
      event.reason === 'promiseRejection' ||
      event.reason === 'other' ||
      event.reason === 'ambiguous';
    const hitAnyBreakpoint = !!(event.hitBreakpoints && event.hitBreakpoints.length);
    if (hitAnyBreakpoint || !sameDebuggingSequence) this._sourceContainer.clearDisabledSourceMaps();

    if (event.hitBreakpoints && this._sourceMapDisabler) {
      for (const sourceToDisable of this._sourceMapDisabler(event.hitBreakpoints))
        this._sourceContainer.disableSourceMapForSource(sourceToDisable);
    }

    const stackTrace = this.launchConfig.showAsyncStacks
      ? StackTrace.fromDebugger(
          this,
          event.callFrames,
          event.asyncStackTrace,
          event.asyncStackTraceId,
        )
      : StackTrace.fromDebugger(this, event.callFrames);
    switch (event.reason) {
      case 'assert':
        return {
          thread: this,
          stackTrace,
          reason: 'exception',
          description: localize('pause.assert', 'Paused on assert'),
        };
      case 'debugCommand':
        return {
          thread: this,
          stackTrace,
          reason: 'pause',
          description: localize('pause.debugCommand', 'Paused on debug() call'),
        };
      case 'DOM':
        return {
          thread: this,
          stackTrace,
          reason: 'data breakpoint',
          description: localize('pause.DomBreakpoint', 'Paused on DOM breakpoint'),
        };
      case 'EventListener':
        return this._resolveEventListenerBreakpointDetails(stackTrace, event);
      case 'exception':
        return {
          thread: this,
          stackTrace,
          reason: 'exception',
          description: localize('pause.exception', 'Paused on exception'),
          exception: event.data as Cdp.Runtime.RemoteObject | undefined,
        };
      case 'promiseRejection':
        return {
          thread: this,
          stackTrace,
          reason: 'exception',
          description: localize('pause.promiseRejection', 'Paused on promise rejection'),
          exception: event.data as Cdp.Runtime.RemoteObject | undefined,
        };
      case 'instrumentation':
        if (event.data && event.data.__rewriteAsBreakpoint) {
          return {
            thread: this,
            stackTrace,
            reason: 'breakpoint',
            description: localize('pause.breakpoint', 'Paused on breakpoint'),
          };
        }
        if (event.data && event.data['scriptId']) {
          return {
            thread: this,
            stackTrace,
            reason: 'step',
            description: localize('pause.default', 'Paused'),
          };
        }
        return {
          thread: this,
          stackTrace,
          reason: 'function breakpoint',
          description: localize('pause.instrumentation', 'Paused on instrumentation breakpoint'),
        };
      case 'XHR':
        return {
          thread: this,
          stackTrace,
          reason: 'data breakpoint',
          description: localize('pause.xhr', 'Paused on XMLHttpRequest or fetch'),
        };
      case 'OOM':
        return {
          thread: this,
          stackTrace,
          reason: 'exception',
          description: localize('pause.oom', 'Paused before Out Of Memory exception'),
        };
      default:
        if (event.hitBreakpoints && event.hitBreakpoints.length) {
          return {
            thread: this,
            stackTrace,
            hitBreakpoints: event.hitBreakpoints,
            reason: 'breakpoint',
            description: localize('pause.breakpoint', 'Paused on breakpoint'),
          };
        }
        if (this._expectedPauseReason) {
          return {
            thread: this,
            stackTrace,
            description: localize('pause.default', 'Paused'),
            ...this._expectedPauseReason,
          };
        }
        return {
          thread: this,
          stackTrace,
          reason: 'pause',
          description: localize('pause.default', 'Paused on debugger statement'),
        };
    }
  }

  _resolveEventListenerBreakpointDetails(
    stackTrace: StackTrace,
    event: Cdp.Debugger.PausedEvent,
  ): IPausedDetails {
    const data = event.data;
    const id = data ? data['eventName'] || '' : '';
    const breakpoint = customBreakpoints().get(id);
    if (breakpoint) {
      const details = breakpoint.details(data);
      return {
        thread: this,
        stackTrace,
        reason: 'function breakpoint',
        description: details.short,
        text: details.long,
      };
    }
    return {
      thread: this,
      stackTrace,
      reason: 'function breakpoint',
      description: localize('pause.eventListener', 'Paused on event listener'),
    };
  }

  async _onConsoleMessage(
    event: Cdp.Runtime.ConsoleAPICalledEvent,
  ): Promise<Dap.OutputEventParams | undefined> {
    switch (event.type) {
      case 'endGroup':
        return;
      case 'clear':
        return this._clearDebuggerConsole();
    }

    let stackTrace: StackTrace | undefined;
    let uiLocation: IUiLocation | undefined;
    const isAssert = event.type === 'assert';
    const isError = event.type === 'error';
    if (event.stackTrace) {
      stackTrace = StackTrace.fromRuntime(this, event.stackTrace);
      const frames = await stackTrace.loadFrames(1);
      if (frames.length) uiLocation = await frames[0].uiLocation();
      if (!isError && event.type !== 'warning' && !isAssert && event.type !== 'trace')
        stackTrace = undefined;
    }

    let category: 'console' | 'stdout' | 'stderr' | 'telemetry' = 'stdout';
    if (isError || isAssert) category = 'stderr';
    if (event.type === 'warning') category = 'console';

    if (isAssert && event.args[0] && event.args[0].value === 'console.assert')
      event.args[0].value = localize('console.assert', 'Assertion failed');

    let messageText: string;
    if (event.type === 'table' && event.args.length && event.args[0].preview) {
      messageText = objectPreview.formatAsTable(event.args[0].preview);
    } else {
      const useMessageFormat = event.args.length > 1 && event.args[0].type === 'string';
      const formatString = useMessageFormat ? (event.args[0].value as string) : '';
      messageText = messageFormat.formatMessage(
        formatString,
        useMessageFormat ? event.args.slice(1) : event.args,
        objectPreview.messageFormatters,
      );
    }

    const variablesReference = await this.replVariables.createVariableForOutput(
      messageText + '\n',
      event.args,
      stackTrace,
    );
    return {
      category,
      output: '',
      variablesReference,
      source: uiLocation ? await uiLocation.source.toDap() : undefined,
      line: uiLocation ? uiLocation.lineNumber : undefined,
      column: uiLocation ? uiLocation.columnNumber : undefined,
    };
  }

  _clearDebuggerConsole(): Dap.OutputEventParams {
    return {
      category: 'console',
      output: '\x1b[2J',
    };
  }

  async _formatException(
    details: Cdp.Runtime.ExceptionDetails,
    prefix?: string,
  ): Promise<Dap.OutputEventParams> {
    const preview = details.exception
      ? objectPreview.previewException(details.exception)
      : { title: '' };
    let message = preview.title;
    if (!message.startsWith('Uncaught')) message = 'Uncaught ' + message;
    message = (prefix || '') + message;

    let stackTrace: StackTrace | undefined;
    let uiLocation: IUiLocation | undefined;
    if (details.stackTrace) stackTrace = StackTrace.fromRuntime(this, details.stackTrace);
    if (stackTrace) {
      const frames = await stackTrace.loadFrames(1);
      if (frames.length) uiLocation = await frames[0].uiLocation();
    }

    const args = details.exception && !preview.stackTrace ? [details.exception] : [];
    let variablesReference = 0;
    if (stackTrace || args.length)
      variablesReference = await this.replVariables.createVariableForOutput(
        message,
        args,
        stackTrace,
      );

    return {
      category: 'stderr',
      output: message,
      variablesReference,
      source: uiLocation ? await uiLocation.source.toDap() : undefined,
      line: uiLocation ? uiLocation.lineNumber : undefined,
      column: uiLocation ? uiLocation.columnNumber : undefined,
    };
  }

  scriptsFromSource(source: Source): Set<Script> {
    return this._sourceScripts.get(source) || new Set();
  }

  _removeAllScripts() {
    const scripts = Array.from(this._scripts.values());
    this._scripts.clear();
    this._scriptSources.clear();
    for (const script of scripts) {
      const set = this.scriptsFromSource(script.source);
      set.delete(script);
      if (!set.size) this._sourceContainer.removeSource(script.source);
    }
  }

  _onScriptParsed(event: Cdp.Debugger.ScriptParsedEvent) {
    if (event.url) event.url = this._delegate.scriptUrlToUrl(event.url);

    let urlHashMap = this._scriptSources.get(event.url);
    if (!urlHashMap) {
      urlHashMap = new Map();
      this._scriptSources.set(event.url, urlHashMap);
    }

    let source: Source | undefined;
    if (event.url && event.hash && urlHashMap) source = urlHashMap.get(event.hash);

    if (!source) {
      const contentGetter = async () => {
        const response = await this._cdp.Debugger.getScriptSource({ scriptId: event.scriptId });
        return response ? response.scriptSource : undefined;
      };
      const inlineSourceOffset =
        event.startLine || event.startColumn
          ? { lineOffset: event.startLine, columnOffset: event.startColumn }
          : undefined;
      let resolvedSourceMapUrl: string | undefined;
      if (event.sourceMapURL && this.launchConfig.sourceMaps) {
        // Note: we should in theory refetch source maps with relative urls, if the base url has changed,
        // but in practice that usually means new scripts with new source maps anyway.
        resolvedSourceMapUrl = event.url && urlUtils.completeUrl(event.url, event.sourceMapURL);
        if (!resolvedSourceMapUrl)
          errors.reportToConsole(this._dap, `Could not load source map from ${event.sourceMapURL}`);
      }

      const hash = this._delegate.shouldCheckContentHash() ? event.hash : undefined;
      source = this._sourceContainer.addSource(
        event.url,
        contentGetter,
        resolvedSourceMapUrl,
        inlineSourceOffset,
        hash,
      );
      urlHashMap.set(event.hash, source);
    }

    const script = { url: event.url, scriptId: event.scriptId, source, hash: event.hash };
    this._scripts.set(event.scriptId, script);

    let scriptSet = this._sourceScripts.get(source);
    if (!scriptSet) {
      scriptSet = new Set();
      this._sourceScripts.set(source, scriptSet);
    }
    scriptSet.add(script);

    if (event.sourceMapURL) {
      // If we won't pause before executing this script, still try to load source
      // map and set breakpoints as soon as possible. This is racy against the
      // script execution, but better than nothing.
      this._getOrStartLoadingSourceMaps(script);
    }
  }

  // Wait for source map to load and set all breakpoints in this particular script.
  async _handleSourceMapPause(scriptId: string): Promise<boolean> {
    this._pausedForSourceMapScriptId = scriptId;
    const timeout = this._sourceContainer.sourceMapTimeouts().scriptPaused;
    const script = this._scripts.get(scriptId);
    if (!script) {
      this._pausedForSourceMapScriptId = undefined;
      return false;
    }

    const result = await Promise.race([this._getOrStartLoadingSourceMaps(script), delay(timeout)]);
    console.assert(this._pausedForSourceMapScriptId === scriptId);
    this._pausedForSourceMapScriptId = undefined;

    return result ? result.remainPaused : false;
  }

  /**
   * Loads sourcemaps for the given script and invokes the handler, if we
   * haven't already done so. Returns a promise that resolves with the
   * handler's results.
   */
  private _getOrStartLoadingSourceMaps(script: Script) {
    const existing = this._sourceMapLoads.get(script.scriptId);
    if (existing) {
      return existing;
    }

    const result = this._sourceContainer
      .waitForSourceMapSources(script.source)
      .then(sources =>
        sources.length && this._scriptWithSourceMapHandler
          ? this._scriptWithSourceMapHandler(script, sources)
          : { remainPaused: false },
      );

    this._sourceMapLoads.set(script.scriptId, result);
    return result;
  }

  async _revealObject(object: Cdp.Runtime.RemoteObject) {
    if (object.type !== 'function' || object.objectId === undefined) return;
    const response = await this._cdp.Runtime.getProperties({
      objectId: object.objectId,
      ownProperties: true,
    });
    if (!response) return;
    for (const p of response.internalProperties || []) {
      if (
        p.name !== '[[FunctionLocation]]' ||
        !p.value ||
        (p.value.subtype as string) !== 'internal#location'
      )
        continue;
      const uiLocation = await this.rawLocationToUiLocation(
        this.rawLocation(p.value.value as Cdp.Debugger.Location),
      );
      if (uiLocation) this._sourceContainer.revealUiLocation(uiLocation);
      break;
    }
  }

  async _copyObjectToClipboard(object: Cdp.Runtime.RemoteObject) {
    if (!object.objectId) {
      this._dap.copyRequested({ text: objectPreview.previewRemoteObject(object, 'copy') });
      return;
    }

    try {
      const result = await toStringForClipboard({
        cdp: this.cdp(),
        objectId: object.objectId,
        args: [object.subtype],
        silent: true,
        returnByValue: true,
      });

      this._dap.copyRequested({ text: result.value });
    } catch (e) {
      // ignored
    } finally {
      this.cdp()
        .Runtime.releaseObject({ objectId: object.objectId })
        .catch(() => undefined);
    }
  }

  async _queryObjects(prototype: Cdp.Runtime.RemoteObject) {
    const slot = this._claimOutputSlot();
    if (!prototype.objectId) return slot();
    const response = await this.cdp().Runtime.queryObjects({
      prototypeObjectId: prototype.objectId,
      objectGroup: 'console',
    });
    await this.cdp().Runtime.releaseObject({ objectId: prototype.objectId });
    if (!response) return slot();

    let withPreview: Cdp.Runtime.RemoteObject;
    try {
      withPreview = await previewThis({
        cdp: this.cdp(),
        args: [],
        objectId: response.objects.objectId,
        objectGroup: 'console',
        generatePreview: true,
      });
    } catch (e) {
      return slot();
    }

    const text =
      '\x1b[32mobjects: ' + objectPreview.previewRemoteObject(withPreview, 'repl') + '\x1b[0m';
    const variablesReference =
      (await this.replVariables.createVariableForOutput(text, [withPreview])) || 0;
    const output = {
      category: 'stdout' as 'stdout',
      output: '',
      variablesReference,
    };
    slot(output);
  }

  async _onThreadPaused(details: IPausedDetails) {
    this._expectedPauseReason = undefined;

    // If we hit breakpoints, try to make sure they all get resolved before we
    // send the event to the UI. This should generally only happen if the UI
    // bulk-set breakpoints and some resolve faster than others, since we expect
    // the CDP in turn will tell *us* they're resolved before hitting them.
    if (details.hitBreakpoints) {
      await Promise.race([
        delay(1000),
        Promise.all(
          details.hitBreakpoints.map(bp =>
            this._breakpointManager._resolvedBreakpoints.get(bp)?.untilSetCompleted(),
          ),
        ),
      ]);
    }

    this._dap.stopped({
      reason: details.reason,
      description: details.description,
      threadId: this.id,
      text: details.text,
      allThreadsStopped: false,
    });
  }

  _onThreadResumed() {
    this._dap.continued({
      threadId: this.id,
      allThreadsContinued: false,
    });
  }

  async setScriptSourceMapHandler(handler?: ScriptWithSourceMapHandler): Promise<void> {
    if (this._scriptWithSourceMapHandler === handler) return;
    this._scriptWithSourceMapHandler = handler;
    const needsPause =
      this.enableInstrumentationBp &&
      this._sourceContainer.sourceMapTimeouts().scriptPaused &&
      handler;

    if (needsPause && !this._pauseOnSourceMapBreakpointId) {
      const result = await this._cdp.Debugger.setInstrumentationBreakpoint({
        instrumentation: 'beforeScriptWithSourceMapExecution',
      });
      this._pauseOnSourceMapBreakpointId = result ? result.breakpointId : undefined;
    } else if (!needsPause && this._pauseOnSourceMapBreakpointId) {
      const breakpointId = this._pauseOnSourceMapBreakpointId;
      this._pauseOnSourceMapBreakpointId = undefined;
      await this._cdp.Debugger.removeBreakpoint({ breakpointId });
    }
  }

  setSourceMapDisabler(sourceMapDisabler?: SourceMapDisabler) {
    this._sourceMapDisabler = sourceMapDisabler;
  }

  static threadForDebuggerId(debuggerId: Cdp.Runtime.UniqueDebuggerId): Thread | undefined {
    return Thread._allThreadsByDebuggerId.get(debuggerId);
  }
}

let scheduledPauseOnAsyncCall: Cdp.Runtime.StackTraceId | undefined;
