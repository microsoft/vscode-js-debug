/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as nls from 'vscode-nls';
import Cdp from '../cdp/api';
import { delay, getDeferred, IDeferred } from '../common/promiseUtil';
import * as sourceUtils from '../common/sourceUtils';
import * as urlUtils from '../common/urlUtils';
import { AnyLaunchConfiguration, OutputSource } from '../configuration';
import Dap from '../dap/api';
import * as errors from '../dap/errors';
import { BreakpointManager, EntryBreakpointMode } from './breakpoints';
import { ICompletions } from './completions';
import { CustomBreakpointId, customBreakpoints } from './customBreakpoints';
import * as messageFormat from './messageFormat';
import * as objectPreview from './objectPreview';
import { SmartStepper } from './smartStepping';
import { IPreferredUiLocation, Source, SourceContainer, IUiLocation, base1To0 } from './sources';
import { StackFrame, StackTrace } from './stackTrace';
import { VariableStore, IVariableStoreDelegate } from './variables';
import { previewThis } from './templates/previewThis';
import { UserDefinedBreakpoint } from './breakpoints/userDefinedBreakpoint';
import { ILogger } from '../common/logging';
import { AnyObject } from './objectPreview/betterTypes';
import { IEvaluator } from './evaluator';
import {
  serializeForClipboardTmpl,
  serializeForClipboard,
} from './templates/serializeForClipboard';
import { EventEmitter } from '../common/events';
import { IBreakpointPathAndId } from '../targets/targets';
import { fileUrlToAbsolutePath } from '../common/urlUtils';

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

export type Script = { url: string; scriptId: string; hash: string; source: Promise<Source> };

export interface IThreadDelegate {
  name(): string;
  supportsCustomBreakpoints(): boolean;
  shouldCheckContentHash(): boolean;
  scriptUrlToUrl(url: string): string;
  executionContextName(description: Cdp.Runtime.ExecutionContextDescription): string;
  initialize(): Promise<void>;
  entryBreakpoint: IBreakpointPathAndId | undefined;
}

export type ScriptWithSourceMapHandler = (
  script: Script,
  sources: Source[],
  brokenOn?: Cdp.Debugger.Location,
) => Promise<IUiLocation[]>;
export type SourceMapDisabler = (hitBreakpoints: string[]) => Source[];

export type RawLocation = {
  url: string;
  lineNumber: number; // 1-based
  columnNumber: number; // 1-based
  scriptId?: Cdp.Runtime.ScriptId;
};

class DeferredContainer<T> {
  private _dapDeferred: IDeferred<T> = getDeferred();

  constructor(private readonly _obj: T) {}

  resolve(): void {
    this._dapDeferred.resolve(this._obj);
  }

  with<Return>(callback: (obj: T) => Return): Return | Promise<Return> {
    if (this._dapDeferred.hasSettled()) {
      return callback(this._obj);
    } else {
      return this._dapDeferred.promise.then(obj => callback(obj));
    }
  }
}

export class Thread implements IVariableStoreDelegate {
  private static _lastThreadId = 0;
  public readonly id: number;
  private _cdp: Cdp.Api;
  private _pausedDetails?: IPausedDetails;
  private _pausedVariables?: VariableStore;
  private _pausedForSourceMapScriptId?: string;
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
  private _sourceMapLoads = new Map<string, Promise<IUiLocation[]>>();
  private readonly _smartStepper: SmartStepper;
  private _expectedPauseReason?: { reason: PausedReason; description?: string };
  private readonly _sourceScripts = new WeakMap<Source, Set<Script>>();
  private readonly _pausedDetailsEvent = new WeakMap<IPausedDetails, Cdp.Debugger.PausedEvent>();
  private readonly _onPausedEmitter = new EventEmitter<IPausedDetails>();
  private readonly _dap: DeferredContainer<Dap.Api>;

  public readonly onPaused = this._onPausedEmitter.event;

  constructor(
    sourceContainer: SourceContainer,
    cdp: Cdp.Api,
    dap: Dap.Api,
    delegate: IThreadDelegate,
    logger: ILogger,
    private readonly evaluator: IEvaluator,
    private readonly completer: ICompletions,
    private readonly launchConfig: AnyLaunchConfiguration,
    private readonly _breakpointManager: BreakpointManager,
  ) {
    this._dap = new DeferredContainer(dap);
    this._delegate = delegate;
    this._sourceContainer = sourceContainer;
    this._cdp = cdp;
    this.id = Thread._lastThreadId++;
    this.replVariables = new VariableStore(this._cdp, this, launchConfig.__autoExpandGetters);
    this._serializedOutput = Promise.resolve();
    this._smartStepper = new SmartStepper(this.launchConfig, logger);
    this._initialize();
  }

  cdp(): Cdp.Api {
    return this._cdp;
  }

  name(): string {
    return this._delegate.name();
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

  public async resume(): Promise<Dap.ContinueResult | Dap.Error> {
    this._sourceContainer.clearDisabledSourceMaps();
    if (!(await this._cdp.Debugger.resume({}))) {
      // We don't report the failure if the target wasn't paused. VS relies on this behavior.
      if (this._pausedDetails !== undefined) {
        return errors.createSilentError(localize('error.resumeDidFail', 'Unable to resume'));
      }
    }
    return { allThreadsContinued: false };
  }

  public async pause(): Promise<Dap.PauseResult | Dap.Error> {
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

  /**
   * Focuses the page for which the thread is attached.
   */
  public async revealPage() {
    this._cdp.Page.bringToFront({});
    return {};
  }

  public async completions(
    params: Dap.CompletionsParams,
  ): Promise<Dap.CompletionsResult | Dap.Error> {
    let stackFrame: StackFrame | undefined;
    if (params.frameId !== undefined) {
      stackFrame = this._pausedDetails
        ? this._pausedDetails.stackTrace.frame(params.frameId)
        : undefined;
      if (!stackFrame) return this._stackFrameNotFoundError();
      if (!stackFrame.callFrameId()) return this._evaluateOnAsyncFrameError();
    }

    // If we're changing an execution context, don't bother with JS completion.
    if (params.line === 1 && params.text.startsWith('cd ')) {
      return { targets: this.getExecutionContextCompletions(params) };
    }

    const targets = await this.completer.completions({
      executionContextId: this._selectedContext ? this._selectedContext.description.id : undefined,
      stackFrame,
      expression: params.text,
      line: params.line || 1,
      column: params.column,
    });

    // Merge the actual completion items with the synthetic target changing items.
    return { targets: [...this.getExecutionContextCompletions(params), ...targets] };
  }

  private getExecutionContextCompletions(params: Dap.CompletionsParams): Dap.CompletionItem[] {
    if (params.line && params.line > 1) {
      return [];
    }

    const prefix = params.text.slice(0, params.column).trim();
    return [...this._executionContexts.values()]
      .map(c => `cd ${this._delegate.executionContextName(c.description)}`)
      .filter(label => label.startsWith(prefix))
      .map(label => ({ label, start: 0, length: params.text.length }));
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

    // For clipboard evaluations, return a safe JSON-stringified string.
    const params: Cdp.Runtime.EvaluateParams =
      args.context === 'clipboard'
        ? {
            expression: serializeForClipboardTmpl(args.expression, '2'),
            includeCommandLineAPI: true,
            returnByValue: true,
            objectGroup: 'console',
          }
        : {
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

    const responsePromise = this.evaluator.evaluate(
      callFrameId
        ? { ...params, callFrameId }
        : {
            ...params,
            contextId: this._selectedContext ? this._selectedContext.description.id : undefined,
          },
    );

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
      throw new errors.ProtocolError(errors.replError(formattedException.output));
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
    this._cdp.Network.enable({});

    this._cdp.Debugger.on('paused', async event => this._onPaused(event));
    this._cdp.Debugger.on('resumed', () => this.onResumed());
    this._cdp.Debugger.on('scriptParsed', event => this._onScriptParsed(event));

    this._ensureDebuggerEnabledAndRefreshDebuggerId();
    this._delegate.initialize();
    this._pauseOnScheduledAsyncCall();

    this._dap.with(dap =>
      dap.thread({
        reason: 'started',
        threadId: this.id,
      }),
    );
  }

  dapInitialized() {
    this._dap.resolve();
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
          this._dap.with(dap => dap.output(payload));
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

  private _executionContextCreated(description: Cdp.Runtime.ExecutionContextDescription) {
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
    if (this._pausedDetails) this.onResumed();
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
    const hitBreakpoints = (event.hitBreakpoints ?? []).filter(
      bp => bp !== this._pauseOnSourceMapBreakpointId,
    );
    const isInspectBrk = (event.reason as string) === 'Break on start';
    const isSourceMapPause =
      (event.reason === 'instrumentation' && event.data?.scriptId) ||
      this._breakpointManager.isEntrypointBreak(hitBreakpoints);
    this.evaluator.setReturnedValue(event.callFrames[0]?.returnValue);

    let shouldPause: boolean;
    if (isSourceMapPause) {
      const location = event.callFrames[0].location;
      const scriptId = event.data?.scriptId || location.scriptId;

      if (this._isWebpackModuleEvalPause(event)) {
        await this._handleWebpackModuleEval();
      }

      // Set shouldPause=true if we just resolved a breakpoint that's on this
      // location; this won't have existed before now.
      shouldPause = await this._handleSourceMapPause(scriptId, location);
      // Set shouldPause=true if there's a non-entry, user defined breakpoint
      // among the remaining points--or an inspect-brk.
      shouldPause =
        shouldPause ||
        isInspectBrk ||
        (await this._breakpointManager.shouldPauseAt(
          event,
          hitBreakpoints,
          this._delegate.entryBreakpoint,
          true,
        ));

      if (
        scheduledPauseOnAsyncCall &&
        event.asyncStackTraceId &&
        scheduledPauseOnAsyncCall.debuggerId === event.asyncStackTraceId.debuggerId &&
        scheduledPauseOnAsyncCall.id === event.asyncStackTraceId.id
      ) {
        // Paused on the script which is run as a task for scheduled async call.
        // We are waiting for this pause, no need to resume.
      } else if (shouldPause) {
        // If should stay paused, that means the user set a breakpoint on
        // the first line (which we are already on!), so pretend it's
        // a breakpoint and let it bubble up.
        if (event.data) {
          event.data.__rewriteAsBreakpoint = true;
        }
      } else {
        await this._pauseOnScheduledAsyncCall();
        this.resume();
        return;
      }
    } else {
      shouldPause = await this._breakpointManager.shouldPauseAt(
        event,
        hitBreakpoints,
        this._delegate.entryBreakpoint,
        false,
      );
    }

    if (event.asyncCallStackTraceId) {
      scheduledPauseOnAsyncCall = event.asyncCallStackTraceId;
      const threads = Array.from(Thread._allThreadsByDebuggerId.values());
      await Promise.all(threads.map(thread => thread._pauseOnScheduledAsyncCall()));
      this.resume();
      return;
    }

    // "Break on start" is not actually a by-spec reason in CDP, it's added on from Node.js, so cast `as string`:
    // https://github.com/nodejs/node/blob/9cbf6af5b5ace0cc53c1a1da3234aeca02522ec6/src/node_contextify.cc#L913
    if (
      isInspectBrk &&
      'continueOnAttach' in this.launchConfig &&
      this.launchConfig.continueOnAttach
    ) {
      this.resume();
      return;
    }

    // We store pausedDetails in a local variable to avoid race conditions while awaiting this._smartStepper.shouldSmartStep
    const pausedDetails = (this._pausedDetails = this._createPausedDetails(event));
    if (!shouldPause) {
      this.resume();
      return;
    }

    const shouldSmartStep = await this._smartStepper.shouldSmartStep(pausedDetails);
    if (this._pausedDetails !== pausedDetails) {
      return;
    }

    if (shouldSmartStep) {
      this.stepInto();
      return;
    }

    this._pausedDetailsEvent.set(pausedDetails, event);
    this._pausedVariables = new VariableStore(
      this._cdp,
      this,
      this.launchConfig.__autoExpandGetters,
    );
    scheduledPauseOnAsyncCall = undefined;

    await this._onThreadPaused(pausedDetails);
  }

  /**
   * Called when CDP indicates that we resumed. This is marked as public since
   * we also call this from the {@link ProfileController} when we disable
   * the debugger domain (which continues the thread but doesn't result in
   * a "resumed" event getting sent).
   */
  onResumed() {
    this._pausedDetails = undefined;
    this._pausedVariables = undefined;
    this.evaluator.setReturnedValue(undefined);
    this._onThreadResumed();
  }

  dispose() {
    this._removeAllScripts(true /* silent */);
    for (const [debuggerId, thread] of Thread._allThreadsByDebuggerId) {
      if (thread === this) Thread._allThreadsByDebuggerId.delete(debuggerId);
    }

    this._executionContextsCleared();

    // Send 'exited' after all other thread-releated events
    this._dap.with(dap =>
      dap.thread({
        reason: 'exited',
        threadId: this.id,
      }),
    );
  }

  rawLocation(
    location: Cdp.Runtime.CallFrame | Cdp.Debugger.CallFrame | Cdp.Debugger.Location,
  ): RawLocation {
    // Note: cdp locations are 0-based, while ui locations are 1-based. Also,
    // some we can *apparently* get negative locations; Vue's "hello world"
    // project was observed to emit source locations at (-1, -1) in its callframe.
    if ('location' in location) {
      const loc = location as Cdp.Debugger.CallFrame;
      return {
        url: loc.url,
        lineNumber: Math.max(0, loc.location.lineNumber) + 1,
        columnNumber: Math.max(0, loc.location.columnNumber || 0) + 1,
        scriptId: loc.location.scriptId,
      };
    }
    return {
      url: (location as Cdp.Runtime.CallFrame).url || '',
      lineNumber: Math.max(0, location.lineNumber) + 1,
      columnNumber: Math.max(0, location.columnNumber || 0) + 1,
      scriptId: location.scriptId,
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

    return this._sourceContainer.preferredUiLocation({
      ...rawLocation,
      source: await script.source,
    });
  }

  /**
   * Gets a script ID if it exists, or waits to up maxTime. In rare cases we
   * can get a request (like a stacktrace request) from DAP before Chrome
   * finishes passing its sources over. We *should* normally know about all
   * possible script IDs; this waits if we see one that we don't.
   */
  private async getScriptByIdOrWait(scriptId: string, maxTime = 500) {
    let script = this._sourceContainer.scriptsById.get(scriptId);
    if (script) {
      return script;
    }

    const deadline = Date.now() + maxTime;
    do {
      await delay(50);
      script = this._sourceContainer.scriptsById.get(scriptId);
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

    const stackTrace = StackTrace.fromDebugger(
      this,
      event.callFrames,
      event.asyncStackTrace,
      event.asyncStackTraceId,
    );

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
          let isStopOnEntry = false; // By default we assume breakpoints aren't stop on entry
          const userEntryBp = this._delegate.entryBreakpoint;
          if (userEntryBp && event.hitBreakpoints.includes(userEntryBp.cdpId)) {
            isStopOnEntry = true; // But if it matches the entry breakpoint id, then it's probably stop on entry
            const entryBreakpointSource = this._sourceContainer.source({
              path: fileUrlToAbsolutePath(userEntryBp.path),
            });

            if (entryBreakpointSource !== undefined) {
              const entryBreakpointLocations = this._sourceContainer.currentSiblingUiLocations({
                lineNumber: event.callFrames[0].location.lineNumber + 1,
                columnNumber: (event.callFrames[0].location.columnNumber || 0) + 1,
                source: entryBreakpointSource,
              });

              // But if there is a user breakpoint on the same location that the stop on entry breakpoint, then we consider it an user breakpoint
              isStopOnEntry = !entryBreakpointLocations.some(location =>
                this._breakpointManager.hasAtLocation(location),
              );
            }
          }

          if (!isStopOnEntry) {
            this._breakpointManager.registerBreakpointsHit(event.hitBreakpoints);
          }
          return {
            thread: this,
            stackTrace,
            hitBreakpoints: event.hitBreakpoints,
            reason: isStopOnEntry ? 'entry' : 'breakpoint',
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
        return { category: 'stdout', output: '', group: 'end' };
      case 'clear':
        return this._clearDebuggerConsole();
    }

    // Ignore the duplicate group events that Node.js can emit:
    // See: https://github.com/nodejs/node/issues/31973
    if (event.type === 'log') {
      const firstFrame = event.stackTrace?.callFrames[0];
      if (
        firstFrame &&
        firstFrame.functionName === 'group' &&
        firstFrame.url === 'internal/console/constructor.js'
      ) {
        return undefined;
      }
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
    let usedAllArgs = false;
    if (event.type === 'table' && event.args.length && event.args[0].preview) {
      messageText = objectPreview.formatAsTable(event.args[0].preview);
    } else {
      const useMessageFormat = event.args.length > 1 && event.args[0].type === 'string';
      const formatString = useMessageFormat ? (event.args[0].value as string) : '';
      const formatResult = messageFormat.formatMessage(
        formatString,
        (useMessageFormat ? event.args.slice(1) : event.args) as AnyObject[],
        objectPreview.messageFormatters,
      );
      messageText = formatResult.result;
      usedAllArgs = formatResult.usedAllSubs;
    }

    let output: string;
    let variablesReference: number | undefined;
    if (!usedAllArgs || event.args.some(arg => objectPreview.previewAsObject(arg))) {
      output = '';
      variablesReference = await this.replVariables.createVariableForOutput(
        messageText + '\n',
        event.args,
        stackTrace,
      );
    } else {
      output = messageText + '\n';
      variablesReference = undefined;
    }

    const group =
      event.type === 'startGroup'
        ? 'start'
        : event.type === 'startGroupCollapsed'
        ? 'startCollapsed'
        : undefined;

    return {
      category,
      output,
      variablesReference,
      group,
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

  private _removeAllScripts(silent = false) {
    const scripts = Array.from(this._sourceContainer.scriptsById.values());
    this._sourceContainer.scriptsById.clear();
    this._scriptSources.clear();
    Promise.all(
      scripts.map(script =>
        script.source.then(source => {
          const set = this.scriptsFromSource(source);
          set.delete(script);
          if (!set.size) {
            this._sourceContainer.removeSource(source, silent);
          }
        }),
      ),
    );
  }

  private _onScriptParsed(event: Cdp.Debugger.ScriptParsedEvent) {
    if (this._sourceContainer.scriptsById.has(event.scriptId)) {
      return;
    }

    if (event.url) event.url = this._delegate.scriptUrlToUrl(event.url);

    let urlHashMap = this._scriptSources.get(event.url);
    if (!urlHashMap) {
      urlHashMap = new Map();
      this._scriptSources.set(event.url, urlHashMap);
    }

    const createSource = async () => {
      const prevSource = event.url && event.hash && urlHashMap && urlHashMap.get(event.hash);
      if (prevSource) {
        prevSource.addScriptId(event.scriptId);
        return prevSource;
      }

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
        resolvedSourceMapUrl = urlUtils.isDataUri(event.sourceMapURL)
          ? event.sourceMapURL
          : event.url && urlUtils.completeUrl(event.url, event.sourceMapURL);
        if (!resolvedSourceMapUrl) {
          this._dap.with(dap =>
            errors.reportToConsole(dap, `Could not load source map from ${event.sourceMapURL}`),
          );
        }
      }

      const hash = this._delegate.shouldCheckContentHash() ? event.hash : undefined;
      const source = await this._sourceContainer.addSource(
        event.url,
        contentGetter,
        resolvedSourceMapUrl,
        inlineSourceOffset,
        hash,
      );
      this._sourceContainer.scriptSkipper.initializeSkippingValueForSource(source, event.scriptId);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      urlHashMap!.set(event.hash, source);
      source.addScriptId(event.scriptId);

      let scriptSet = this._sourceScripts.get(source);
      if (!scriptSet) {
        scriptSet = new Set();
        this._sourceScripts.set(source, scriptSet);
      }
      scriptSet.add(script);

      return source;
    };

    const script = {
      url: event.url,
      scriptId: event.scriptId,
      source: createSource(),
      hash: event.hash,
    };
    this._sourceContainer.scriptsById.set(event.scriptId, script);

    if (event.sourceMapURL) {
      // If we won't pause before executing this script, still try to load source
      // map and set breakpoints as soon as possible. We pause on the first line
      // (the "module entry breakpoint") to ensure this resolves.
      this._getOrStartLoadingSourceMaps(script);
    }
  }

  /**
   * Wait for source map to load and set all breakpoints in this particular
   * script. Returns true if the debugger should remain paused.
   */
  async _handleSourceMapPause(scriptId: string, brokenOn: Cdp.Debugger.Location): Promise<boolean> {
    this._pausedForSourceMapScriptId = scriptId;
    const timeout = this._sourceContainer.sourceMapTimeouts().scriptPaused;
    const script = this._sourceContainer.scriptsById.get(scriptId);
    if (!script) {
      this._pausedForSourceMapScriptId = undefined;
      return false;
    }

    const result = await Promise.race([
      this._getOrStartLoadingSourceMaps(script, brokenOn),
      delay(timeout),
    ]);
    console.assert(this._pausedForSourceMapScriptId === scriptId);
    this._pausedForSourceMapScriptId = undefined;

    return (
      !!result &&
      result
        .map(base1To0)
        .some(
          b =>
            b.lineNumber === brokenOn.lineNumber &&
            (brokenOn.columnNumber === undefined || brokenOn.columnNumber === b.columnNumber),
        )
    );
  }

  /**
   * Loads sourcemaps for the given script and invokes the handler, if we
   * haven't already done so. Returns a promise that resolves with the
   * handler's results.
   */
  private _getOrStartLoadingSourceMaps(script: Script, brokenOn?: Cdp.Debugger.Location) {
    const existing = this._sourceMapLoads.get(script.scriptId);
    if (existing) {
      return existing;
    }

    const result = script.source
      .then(source => this._sourceContainer.waitForSourceMapSources(source))
      .then(sources =>
        sources.length && this._scriptWithSourceMapHandler
          ? this._scriptWithSourceMapHandler(script, sources, brokenOn)
          : [],
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
      this._dap.with(dap =>
        dap.copyRequested({ text: objectPreview.previewRemoteObject(object, 'copy') }),
      );
      return;
    }

    try {
      const result = await serializeForClipboard({
        cdp: this.cdp(),
        objectId: object.objectId,
        args: [2],
        silent: true,
        returnByValue: true,
      });

      this._dap.with(dap => dap.copyRequested({ text: result.value }));
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

  private async _onThreadPaused(details: IPausedDetails) {
    this._expectedPauseReason = undefined;
    this._onPausedEmitter.fire(details);

    // If we hit breakpoints, try to make sure they all get resolved before we
    // send the event to the UI. This should generally only happen if the UI
    // bulk-set breakpoints and some resolve faster than others, since we expect
    // the CDP in turn will tell *us* they're resolved before hitting them.
    if (details.hitBreakpoints) {
      await Promise.race([
        delay(1000),
        Promise.all(
          details.hitBreakpoints
            .map(bp => this._breakpointManager._resolvedBreakpoints.get(bp))
            .filter((bp): bp is UserDefinedBreakpoint => bp instanceof UserDefinedBreakpoint)
            .map(r => r.untilSetCompleted()),
        ),
      ]);
    }

    this._dap.with(dap =>
      dap.stopped({
        reason: details.reason,
        description: details.description,
        threadId: this.id,
        text: details.text,
        allThreadsStopped: false,
      }),
    );
  }

  private _onThreadResumed() {
    this._dap.with(dap =>
      dap.continued({
        threadId: this.id,
        allThreadsContinued: false,
      }),
    );
  }

  public async setScriptSourceMapHandler(
    pause: boolean,
    handler?: ScriptWithSourceMapHandler,
  ): Promise<void> {
    this._scriptWithSourceMapHandler = handler;

    const needsPause = pause && this._sourceContainer.sourceMapTimeouts().scriptPaused && handler;
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

  /**
   * Handles a paused event that is an instrumentation breakpoint on what
   * looks like a webpack module eval bundle. These bundles are made up of
   * separate `eval()` calls for each different module, each of which has their
   * own source map. Because of this, pausing when we see a script with a
   * sourcemap becomes incredibly slow.
   *
   * If we enounter this, we remove the instrumentation breakpoint and instead
   * tell our breakpoint manager to set very aggressively-matched entrypoint
   * breakpoints and use those instead. It's not quite as accurate, but it's
   * far better than takes minutes to load simple apps.
   *
   * (You might ask "what does Chrome devtools do here?" The answer is:
   * nothing. They don't seem to have special logic to ensure we set
   * breakpoints before evaluating code, they just work as fast as they can and
   * hope the breakpoints get set in time.)
   */
  private async _handleWebpackModuleEval() {
    await this._breakpointManager.updateEntryBreakpointMode(this, EntryBreakpointMode.Greedy);
    await this.setScriptSourceMapHandler(false, this._scriptWithSourceMapHandler);
  }

  private _isWebpackModuleEvalPause(event: Cdp.Debugger.PausedEvent) {
    return (
      event.reason === 'instrumentation' &&
      event.data &&
      event.data.url?.startsWith('webpack') &&
      event.data.sourceMapURL?.startsWith('data:')
    );
  }

  setSourceMapDisabler(sourceMapDisabler?: SourceMapDisabler) {
    this._sourceMapDisabler = sourceMapDisabler;
  }

  static threadForDebuggerId(debuggerId: Cdp.Runtime.UniqueDebuggerId): Thread | undefined {
    return Thread._allThreadsByDebuggerId.get(debuggerId);
  }
}

let scheduledPauseOnAsyncCall: Cdp.Runtime.StackTraceId | undefined;
