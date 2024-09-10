/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { randomBytes } from 'crypto';
import Cdp from '../cdp/api';
import { DebugType } from '../common/contributionUtils';
import { EventEmitter } from '../common/events';
import { HrTime } from '../common/hrnow';
import { ILogger, LogTag } from '../common/logging';
import { isInstanceOf, truthy } from '../common/objUtils';
import { Base0Position, Base1Position, Range } from '../common/positions';
import { delay, getDeferred, IDeferred } from '../common/promiseUtil';
import { IRenameProvider } from '../common/sourceMaps/renameProvider';
import * as sourceUtils from '../common/sourceUtils';
import { StackTraceParser } from '../common/stackTraceParser';
import { PositionToOffset } from '../common/stringUtils';
import * as urlUtils from '../common/urlUtils';
import { fileUrlToAbsolutePath } from '../common/urlUtils';
import { AnyLaunchConfiguration, IChromiumBaseConfiguration, OutputSource } from '../configuration';
import Dap from '../dap/api';
import * as errors from '../dap/errors';
import { ProtocolError } from '../dap/protocolError';
import { NodeWorkerTarget } from '../targets/node/nodeWorkerTarget';
import { ITarget } from '../targets/targets';
import { IShutdownParticipants } from '../ui/shutdownParticipants';
import { BreakpointManager, EntryBreakpointMode } from './breakpoints';
import { UserDefinedBreakpoint } from './breakpoints/userDefinedBreakpoint';
import { IClientCapabilies } from './clientCapabilities';
import { ICompletions } from './completions';
import { ExceptionMessage, IConsole, QueryObjectsMessage } from './console';
import { customBreakpoints } from './customBreakpoints';
import { IEvaluator, LocationEvaluateOptions } from './evaluator';
import { IExceptionPauseService } from './exceptionPauseService';
import * as objectPreview from './objectPreview';
import { getContextForType, PreviewContextType } from './objectPreview/contexts';
import { ExpectedPauseReason, IPausedDetails, StepDirection } from './pause';
import { SmartStepper } from './smartStepping';
import {
  base1To0,
  ISourceScript,
  ISourceWithMap,
  isSourceWithWasm,
  IUiLocation,
  Source,
} from './source';
import { IPreferredUiLocation, SourceContainer } from './sourceContainer';
import { InlinedFrame, isStackFrameElement, StackFrame, StackTrace } from './stackTrace';
import {
  serializeForClipboard,
  serializeForClipboardTmpl,
} from './templates/serializeForClipboard';
import { IVariableStoreLocationProvider, VariableStore } from './variableStore';

export class ExecutionContext {
  public readonly sourceMapLoads = new Map<string, Promise<IUiLocation[]>>();
  public readonly scripts: Script[] = [];

  constructor(public readonly description: Cdp.Runtime.ExecutionContextDescription) {}

  get isDefault(): boolean {
    return this.description.auxData && this.description.auxData['isDefault'];
  }

  /** Removes all scripts associated with the context */
  async remove(container: SourceContainer) {
    await Promise.all(
      this.scripts.map(async s => {
        const source = await s.source;
        source.filterScripts(s => s.executionContextId !== this.description.id);
        if (!source.scripts.length) {
          container.removeSource(source);
        }
      }),
    );
  }
}

export type Script = ISourceScript & {
  source: Promise<Source>;
  resolvedSource?: Source;
};

export type ScriptWithSourceMapHandler = (
  script: Script,
  sources: Source[],
) => Promise<IUiLocation[]>;
export type SourceMapDisabler = (hitBreakpoints: string[]) => ISourceWithMap[];

export type RawLocation = {
  lineNumber: number; // 1-based
  columnNumber: number; // 1-based
  scriptId: Cdp.Runtime.ScriptId;
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

const excludedCallerSearchDepth = 50;

const sourcesEqual = (a: Dap.Source, b: Dap.Source) =>
  a.sourceReference === b.sourceReference
  && urlUtils.comparePathsWithoutCasing(a.path || '', b.path || '');

const getReplSourceSuffix = () =>
  `\n//# sourceURL=eval-${
    randomBytes(4).toString('hex')
  }${sourceUtils.SourceConstants.ReplExtension}\n`;

/** Auxillary data present in Cdp.Debugger.Paused events in recent Chrome versions */
interface IInstrumentationPauseAuxData {
  scriptId: string;
  url: string;
  sourceMapURL: string;
}

/**
 * Queue used to avoid getting into a bad state if the user runs multiple
 * state-changing commands concurrently. Some things can cause V8 to block
 * and take a while responding to requests. Mutliple requests of the same
 * operation type get coalesced, while other operation types are
 * run sequentially.
 */
class StateQueue {
  private queue?: { operation: string; result: Promise<unknown> };

  public async enqueue<T>(operation: string, fn: () => Promise<T>) {
    // If we would no-op the task because it's already ongoing, make sure we flush
    // microtasks first to avoid a race https://github.com/microsoft/vscode/issues/204581
    if (this.queue?.operation === operation) {
      await new Promise<void>(r => queueMicrotask(r));
    }

    if (!this.queue || this.queue.operation !== operation) {
      const promise = this.queue?.result.then(fn, fn) ?? fn();
      const queued = (this.queue = {
        operation,
        result: promise.finally(() => {
          if (this.queue === queued) {
            this.queue = undefined;
          }
        }),
      });
    }

    return this.queue.result as Promise<T>;
  }
}

const enum CustomBreakpointPrefix {
  XHR = 'x',
  Event = 'e',
}

export class Thread implements IVariableStoreLocationProvider {
  private static _lastThreadId = 0;
  public readonly id: number;
  private _cdp: Cdp.Api;
  private _pausedDetails?: IPausedDetails;
  private _pausedVariables?: VariableStore;
  private _pausedForSourceMapScriptId?: string;
  private _executionContexts: Map<number, ExecutionContext> = new Map();
  readonly replVariables: VariableStore;
  readonly _sourceContainer: SourceContainer;
  private _pauseOnSourceMapBreakpointIds?: Cdp.Debugger.BreakpointId[];
  private _selectedContext: ExecutionContext | undefined;
  static _allThreadsByDebuggerId = new Map<Cdp.Runtime.UniqueDebuggerId, Thread>();
  private _scriptWithSourceMapHandler?: ScriptWithSourceMapHandler;
  private _sourceMapDisabler?: SourceMapDisabler;
  private _expectedPauseReason?: ExpectedPauseReason;
  private _excludedCallers: readonly Dap.ExcludedCaller[] = [];
  private _enabledCustomBreakpoints?: ReadonlySet<string>;
  private readonly stateQueue = new StateQueue();
  private readonly _onPausedEmitter = new EventEmitter<IPausedDetails>();
  private readonly _dap: DeferredContainer<Dap.Api>;
  private disposed = false;

  public debuggerReady = getDeferred<void>();

  /**
   * Details set when a "step in" is issued. Used allow async stepping in
   * sourcemapped worker scripts, and step in targets.
   * @see https://github.com/microsoft/vscode-js-debug/issues/223
   */
  private _waitingForStepIn?: {
    // Last paused details
    lastDetails?: IPausedDetails;
    // Target we're stepping into, if we stepped into a target
    intoTargetBreakpoint?: Cdp.Debugger.BreakpointId;
  };

  public readonly onPaused = this._onPausedEmitter.event;

  constructor(
    sourceContainer: SourceContainer,
    cdp: Cdp.Api,
    dap: Dap.Api,
    private readonly target: ITarget,
    renameProvider: IRenameProvider,
    private readonly logger: ILogger,
    private readonly evaluator: IEvaluator,
    private readonly completer: ICompletions,
    private readonly launchConfig: AnyLaunchConfiguration,
    private readonly _breakpointManager: BreakpointManager,
    private readonly console: IConsole,
    private readonly exceptionPause: IExceptionPauseService,
    private readonly _smartStepper: SmartStepper,
    private readonly shutdown: IShutdownParticipants,
    clientCapabilities: IClientCapabilies,
  ) {
    this._dap = new DeferredContainer(dap);
    this._sourceContainer = sourceContainer;
    this._cdp = cdp;
    this.id = Thread._lastThreadId++;
    this.replVariables = new VariableStore(
      renameProvider,
      this._cdp,
      dap,
      launchConfig,
      clientCapabilities,
      this,
    );
    sourceContainer.onSourceMappedSteppingChange(() => this.refreshStackTrace());
    this._initialize();
  }

  public setExcludedCallers(callers: readonly Dap.ExcludedCaller[]) {
    this._excludedCallers = callers;
  }

  cdp(): Cdp.Api {
    return this._cdp;
  }

  name(): string {
    return this.target.name();
  }

  pausedDetails(): IPausedDetails | undefined {
    return this._pausedDetails;
  }

  pausedVariables(): VariableStore | undefined {
    return this._pausedVariables;
  }

  defaultExecutionContext(): ExecutionContext | undefined {
    for (const context of this._executionContexts.values()) {
      if (context.isDefault) return context;
    }
  }

  public resume(): Promise<Dap.ContinueResult | Dap.Error> {
    return this.stateQueue.enqueue('resume', async () => {
      this._sourceContainer.clearDisabledSourceMaps();
      if (!(await this._cdp.Debugger.resume({}))) {
        // We don't report the failure if the target wasn't paused. VS relies on this behavior.
        if (this._pausedDetails !== undefined) {
          return errors.createSilentError(l10n.t('Unable to resume'));
        }
      }
      return { allThreadsContinued: false };
    });
  }

  public pause(): Promise<Dap.PauseResult | Dap.Error> {
    return this.stateQueue.enqueue('pause', async () => {
      this._expectedPauseReason = { reason: 'pause' };

      if (await this._cdp.Debugger.pause({})) {
        return {};
      }

      return errors.createSilentError(l10n.t('Unable to pause'));
    });
  }

  public stepOver(): Promise<Dap.NextResult | Dap.Error> {
    return this.stateQueue.enqueue('stepOver', async () => {
      this._expectedPauseReason = { reason: 'step', direction: StepDirection.Over };
      const skipList = await this.getCurrentSkipList(StepDirection.Over);
      if (await this._cdp.Debugger.stepOver({ skipList })) {
        return {};
      }

      return errors.createSilentError(l10n.t('Unable to step next'));
    });
  }

  public stepInto(targetId?: number): Promise<Dap.StepInResult | Dap.Error> {
    return this.stateQueue.enqueue('stepInto', async () => {
      this._waitingForStepIn = { lastDetails: this._pausedDetails };
      this._expectedPauseReason = { reason: 'step', direction: StepDirection.In };

      const stepInTarget = this._pausedDetails?.stepInTargets?.[targetId as number];
      if (stepInTarget) {
        const breakpoint = await this._cdp.Debugger.setBreakpoint({
          location: stepInTarget.breakLocation,
        });
        this._waitingForStepIn.intoTargetBreakpoint = breakpoint?.breakpointId;
        if (await this._cdp.Debugger.resume({})) {
          return {};
        }
      } else {
        const skipList = await this.getCurrentSkipList(StepDirection.In);
        if (await this._cdp.Debugger.stepInto({ breakOnAsyncCall: true, skipList })) {
          return {};
        }
      }

      return errors.createSilentError(l10n.t('Unable to step in'));
    });
  }

  public stepOut(): Promise<Dap.StepOutResult | Dap.Error> {
    return this.stateQueue.enqueue('stepOut', async () => {
      this._expectedPauseReason = { reason: 'step', direction: StepDirection.Out };

      if (await this._cdp.Debugger.stepOut({})) {
        return {};
      }

      return errors.createSilentError(l10n.t('Unable to step out'));
    });
  }

  private async getCurrentSkipList(direction: StepDirection) {
    if (!this._pausedDetails) {
      return;
    }

    const [frame] = await this._pausedDetails.stackTrace.loadFrames(1);
    if (!frame || !isStackFrameElement(frame)) {
      return undefined;
    }

    const list = await frame.getStepSkipList(direction);
    if (!list) {
      return undefined;
    }

    // make sure to simplify the range, as V8 is picky about
    // wanting the ranges in order and non-overlapping.
    return Range.simplify(list).map(
      (r): Cdp.Debugger.LocationRange => ({
        start: r.begin.base0,
        end: r.end.base0,
        scriptId: frame.root.scriptId,
      }),
    );
  }

  _stackFrameNotFoundError(): Dap.Error {
    return errors.createSilentError(l10n.t('Stack frame not found'));
  }

  _evaluateOnAsyncFrameError(): Dap.Error {
    return errors.createSilentError(l10n.t('Unable to evaluate on async stack frame'));
  }

  async restartFrame(params: Dap.RestartFrameParams): Promise<Dap.RestartFrameResult | Dap.Error> {
    const stackFrame = this._pausedDetails?.stackTrace.frame(params.frameId)?.root;
    if (!stackFrame) {
      return this._stackFrameNotFoundError();
    }

    const callFrameId = stackFrame.callFrameId();
    if (!callFrameId) {
      return errors.createUserError(l10n.t('Cannot restart asynchronous frame'));
    }

    // Cast is necessary since the devtools-protocol is being slow to update:
    // https://github.com/microsoft/vscode-js-debug/issues/1283#issuecomment-1148219994
    // https://github.com/ChromeDevTools/devtools-protocol/issues/263
    const ok = await this._cdp.Debugger.restartFrame({
      callFrameId,
      mode: 'StepInto',
    } as Cdp.Debugger.RestartFrameParams);
    if (!ok) {
      return errors.createUserError(l10n.t('Frame could not be restarted'));
    }

    this._expectedPauseReason = {
      reason: 'frame_entry',
      description: l10n.t('Paused on frame entry'),
    };

    // Chromium versions before 104 didn't have an explicit `canBeRestarted`
    // flag on their call frame. And on those versions, when we `restartFrame`,
    // we need to manually `stepInto` to unpause. However, with 104, restarting
    // the frame will automatically resume execution.
    if (!stackFrame.canExplicitlyBeRestarted) {
      await this._cdp.Debugger.stepInto({});
    }

    return {};
  }

  async stackTrace(params: Dap.StackTraceParams): Promise<Dap.StackTraceResult | Dap.Error> {
    if (!this._pausedDetails) return errors.createSilentError(l10n.t('Thread is not paused'));
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
    if (!exception) return errors.createSilentError(l10n.t('Thread is not paused on exception'));
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
        ? this._pausedDetails.stackTrace.frame(params.frameId)?.root
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
      position: new Base1Position(params.line || 1, params.column),
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
      .map(c => `cd ${this.target.executionContextName(c.description)}`)
      .filter(label => label.startsWith(prefix))
      .map(label => ({ label, start: 0, length: params.text.length }));
  }

  /**
   * Evaluates the expression on the stackframe if it's a WASM stackframe with
   * evaluation information. Returns undefined otherwise.
   */
  private async _evaluteWasm(
    stackFrame: StackFrame | InlinedFrame | undefined,
    args: Dap.EvaluateParamsExtended,
    variables: VariableStore,
  ): Promise<Dap.Variable | undefined> {
    if (!stackFrame) {
      return;
    }

    const root = stackFrame.root;
    const cfId = root.callFrameId();
    const source = await root.scriptSource?.source;
    if (!isSourceWithWasm(source) || !cfId) {
      return;
    }

    const symbols = await source.sourceMap.value.promise;
    if (!symbols.evaluate) {
      return;
    }

    const position = new Base0Position(
      stackFrame instanceof InlinedFrame ? stackFrame.inlineFrameIndex : 0,
      root.rawPosition.base0.columnNumber,
    );

    const result = await symbols.evaluate(cfId, position, args.expression);
    if (result) {
      return await variables
        .createFloatingVariable(args.expression, result)
        .toDap(args.context as PreviewContextType, args.format);
    }
  }

  /**
   * Evaluates the expression on the stackframe.
   */
  private async _evaluteJs(
    stackFrame: StackFrame | InlinedFrame | undefined,
    args: Dap.EvaluateParamsExtended,
    variables: VariableStore,
  ): Promise<Dap.Variable> {
    // For clipboard evaluations, return a safe JSON-stringified string.
    const params: Cdp.Runtime.EvaluateParams = args.context === 'clipboard'
      ? {
        expression: serializeForClipboardTmpl.expr(args.expression, '2'),
        includeCommandLineAPI: true,
        returnByValue: true,
        objectGroup: 'console',
      }
      : {
        expression: args.expression,
        includeCommandLineAPI: true,
        objectGroup: 'console',
        generatePreview: true,
        timeout: args.context === 'hover' ? this.getHoverEvalTimeout() : undefined,
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
      params.expression += getReplSourceSuffix();
    }

    if (args.evaluationOptions) {
      this.cdp().DotnetDebugger.setEvaluationOptions({
        options: args.evaluationOptions,
        type: 'evaluation',
      });
    }

    let location: LocationEvaluateOptions | undefined;
    if (args.source && args.line && args.column) {
      const variables = this._pausedVariables;
      const source = this._sourceContainer.source(args.source);
      if (source && variables) {
        location = { source, position: new Base1Position(args.line, args.column), variables };
      }
    }

    const callFrameId = stackFrame?.root.callFrameId();
    const responsePromise = this.evaluator.evaluate(
      callFrameId
        ? { ...params, callFrameId }
        : {
          ...params,
          contextId: this._selectedContext ? this._selectedContext.description.id : undefined,
        },
      { isInternalScript: false, stackFrame: stackFrame?.root, location },
    );

    // Report result for repl immediately so that the user could see the expression they entered.
    if (args.context === 'repl') {
      return await this._evaluateRepl(args, responsePromise, args.format);
    }

    const response = await responsePromise;

    if (!response) {
      throw new ProtocolError(errors.createSilentError(l10n.t('Unable to evaluate')));
    }
    if (response.exceptionDetails) {
      let text = response.exceptionDetails.exception
        ? objectPreview.previewException(response.exceptionDetails.exception).title
        : response.exceptionDetails.text;
      if (!text.startsWith('Uncaught')) text = 'Uncaught ' + text;
      throw new ProtocolError(errors.createSilentError(text));
    }

    return variables
      .createFloatingVariable(params.expression, response.result)
      .toDap(args.context as PreviewContextType, args.format);
  }

  public async evaluate(args: Dap.EvaluateParamsExtended): Promise<Dap.EvaluateResult> {
    let callFrameId: Cdp.Debugger.CallFrameId | undefined;
    let stackFrame: StackFrame | InlinedFrame | undefined;
    if (args.frameId !== undefined) {
      stackFrame = this._pausedDetails
        ? this._pausedDetails.stackTrace.frame(args.frameId)
        : undefined;

      if (!stackFrame) {
        throw new ProtocolError(this._stackFrameNotFoundError());
      }

      callFrameId = stackFrame.root.callFrameId();
      if (!callFrameId) {
        throw new ProtocolError(this._evaluateOnAsyncFrameError());
      }
    }

    if (args.context === 'repl' && args.expression.startsWith('cd ')) {
      const contextName = args.expression.substring('cd '.length).trim();
      for (const ec of this._executionContexts.values()) {
        if (this.target.executionContextName(ec.description) === contextName) {
          this._selectedContext = ec;
          return {
            result: `[${contextName}]`,
            variablesReference: 0,
          };
        }
      }
    }

    const variableStore = callFrameId ? this._pausedVariables : this.replVariables;
    if (!variableStore) {
      throw new ProtocolError(errors.createSilentError(l10n.t('Unable to evaluate')));
    }

    const variable = (await this._evaluteWasm(stackFrame, args, variableStore))
      ?? (await this._evaluteJs(stackFrame, args, variableStore));

    return {
      type: variable.type,
      result: variable.value,
      variablesReference: variable.variablesReference,
      namedVariables: variable.namedVariables,
      indexedVariables: variable.indexedVariables,
      memoryReference: variable.memoryReference,
      valueLocationReference: variable.valueLocationReference,
    };
  }

  private getHoverEvalTimeout() {
    const configuredTimeout = this.launchConfig.timeouts?.hoverEvaluation;
    if (configuredTimeout === undefined) {
      return 500;
    }
    if (configuredTimeout <= 0) {
      return undefined;
    }
    return configuredTimeout;
  }

  async _evaluateRepl(
    originalCall: Dap.EvaluateParams,
    responsePromise:
      | Promise<Cdp.Runtime.EvaluateResult | undefined>
      | Promise<Cdp.Debugger.EvaluateOnCallFrameResult | undefined>,
    format: Dap.ValueFormat | undefined,
  ): Promise<Dap.Variable> {
    const response = await responsePromise;
    if (!response) return { name: originalCall.expression, value: '', variablesReference: 0 };

    if (response.exceptionDetails) {
      const formattedException = await new ExceptionMessage(response.exceptionDetails).toDap(this);
      throw new ProtocolError(errors.replError(formattedException.output));
    }

    const contextName =
      this._selectedContext && this.defaultExecutionContext() !== this._selectedContext
        ? `\x1b[33m[${this.target.executionContextName(this._selectedContext.description)}] `
        : '';
    const resultVar = await this.replVariables
      .createFloatingVariable(originalCall.expression, response.result)
      .toDap(PreviewContextType.Repl, format);

    const budget = getContextForType(PreviewContextType.Repl).budget;
    // If it looks like output was truncated by the budget, show a message
    // after the output is returned hinting they can copy the whole thing.
    if (resultVar.variablesReference === 0 && resultVar.value.length === budget) {
      setImmediate(() =>
        this.console.enqueue(this, {
          toDap: () => ({
            output: l10n.t(
              'Output has been truncated to the first {0} characters. Run `{1}` to copy the full output.',
              budget,
              `copy(${originalCall.expression.trim()})`,
            ),
            category: 'stdout',
          }),
        })
      );
    }

    return { ...resultVar, value: `${contextName}${resultVar.value}` };
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
    this._cdp.Inspector.on('targetReloadedAfterCrash', () => {
      // It was reported that crashing targets sometimes loses breakpoints.
      // I could not reproduce this by calling `Page.crash()`, but put this fix
      // in nevertheless; it should be safe.
      this._breakpointManager.reapply();
    });
    if (this.launchConfig.outputCapture === OutputSource.Console) {
      this._cdp.Runtime.on('consoleAPICalled', event => {
        this.console.dispatch(this, event);
      });
      this._cdp.Runtime.on('exceptionThrown', event => {
        this.console.enqueue(this, new ExceptionMessage(event.exceptionDetails));
      });
    }
    this._cdp.Runtime.on('inspectRequested', event => {
      if (event.hints['copyToClipboard']) {
        this._copyObjectToClipboard(event.object);
      } else if (event.hints['queryObjects']) {
        this.console.enqueue(this, new QueryObjectsMessage(event.object, this.cdp()));
      } else this._revealObject(event.object);
    });

    this._cdp.Debugger.on('paused', async event => this._onPaused(event));
    this._cdp.Debugger.on('resumed', () => this.onResumed());
    this._cdp.Debugger.on('scriptParsed', event => this._onScriptParsed(event));
    this._cdp.Debugger.on('scriptFailedToParse', event => this._onScriptParsed(event));
    this._cdp.Runtime.enable({});

    // The profilder domain is required to be always on in order to support
    // console.profile/console.endProfile. Otherwise, these just no-op.
    this._cdp.Profiler.enable({});

    this._ensureDebuggerEnabledAndRefreshDebuggerId();

    if (this.launchConfig.noDebug) {
      this.logger.info(LogTag.RuntimeLaunch, 'Running with noDebug, so debug domains are disabled');
    }

    this.target.initialize();

    this._dap.with(dap =>
      dap.thread({
        reason: 'started',
        threadId: this.id,
      })
    );
  }

  dapInitialized() {
    this._dap.resolve();
  }

  /**
   * Tries to enable networking for the target
   */
  async enableNetworking({
    mirrorEvents,
  }: Dap.EnableNetworkingParams): Promise<Dap.EnableNetworkingResult> {
    const ok = await this._cdp.Network.enable({});
    if (!ok) {
      throw errors.networkingNotAvailable();
    }

    this._dap.with(dap => {
      for (const event of mirrorEvents) {
        // the types don't work well with the overloads on Network.on, a cast is needed:
        (this._cdp.Network.on as (ev: string, fn: (d: object) => void) => void)(
          event,
          data => dap.networkEvent({ data, event }),
        );
      }
    });

    return {};
  }

  /**
   * Implements DAP `stepInTargets` request.
   *
   * @todo location information is patched in until ratification of
   * https://github.com/microsoft/debug-adapter-protocol/issues/274
   */
  public async getStepInTargets(frameId: number): Promise<
    (Dap.StepInTarget & {
      line?: number;
      column?: number;
      endLine?: number;
      endColumn?: number;
    })[]
  > {
    const pausedDetails = this._pausedDetails;
    if (!pausedDetails) {
      return [];
    }

    const frame = pausedDetails.stackTrace.frames.find(f => f.frameId === frameId);
    if (!(frame instanceof StackFrame)) {
      return [];
    }

    const pausedLocation = await frame.uiLocation();
    if (!pausedLocation) {
      return [];
    }

    const rawPausedLocation = pausedDetails.event.callFrames[0].location;
    const [locations, content] = await Promise.all([
      this._breakpointManager
        .getBreakpointLocations(
          this,
          pausedLocation.source,
          new Base1Position(pausedLocation.lineNumber, 1),
          new Base1Position(pausedLocation.lineNumber + 1, 1),
        )
        .then(l =>
          // remove the currently-paused location
          l.filter(
            l =>
              l.breakLocation.lineNumber !== rawPausedLocation.lineNumber
              || l.breakLocation.columnNumber !== rawPausedLocation.columnNumber,
          )
        ),
      pausedLocation.source.content(),
    ]);

    // V8's breakpoint locations are placed directly before the function to
    // be called, which is perfect, e.g `this.*greet()`. However, once mapped,
    // many tools will make the entire `this.greet(` a single range, which
    // means default behavior of reading the next word will not give a good
    // location. Instead, look over the source content manually to build ranges.

    const idStart = pausedDetails.stepInTargets?.length || 0;
    pausedDetails.stepInTargets = pausedDetails.stepInTargets?.concat(locations) || locations;

    const lines = content && new PositionToOffset(content);

    return locations
      .map((location, i) => {
        const preferred = location.uiLocations.find(l => l.source === pausedLocation.source);
        if (!preferred) {
          return;
        }

        if (!lines) {
          return {
            id: idStart + i,
            label: `Column ${preferred}`,
            line: preferred.lineNumber,
            column: preferred.columnNumber,
          };
        }

        const target = sourceUtils.getStepTargetInfo(
          content.slice(
            lines.getLineOffset(preferred.lineNumber - 1),
            lines.getLineOffset(preferred.lineNumber),
          ),
          preferred.columnNumber - 1,
        );

        if (!target) {
          return;
        }

        return {
          id: idStart + i,
          label: target.text,
          line: preferred.lineNumber,
          column: target.start + 1,
          endLine: preferred.lineNumber,
          endColumn: target.end + 1,
        };
      })
      .filter(truthy);
  }

  async refreshStackTrace() {
    if (!this._pausedDetails) {
      return;
    }

    this._pausedDetails = await this._createPausedDetails(this._pausedDetails.event);
    this._onThreadResumed();
    await this._onThreadPaused(this._pausedDetails);
  }

  private _executionContextCreated(description: Cdp.Runtime.ExecutionContextDescription) {
    const context = new ExecutionContext(description);
    this._executionContexts.set(description.id, context);
  }

  async _executionContextDestroyed(contextId: number) {
    const context = this._executionContexts.get(contextId);
    if (!context) return;
    this._executionContexts.delete(contextId);
    await this.shutdown.shutdownContext();
    context.remove(this._sourceContainer);
  }

  async _executionContextsCleared() {
    const removedContexts = [...this._executionContexts.values()];
    const pausedDetails = this._pausedDetails;
    this._executionContexts.clear();

    await this.shutdown.shutdownContext();
    for (const context of removedContexts) {
      context.remove(this._sourceContainer);
    }
    this._breakpointManager.executionContextWasCleared();

    if (pausedDetails && pausedDetails === this._pausedDetails) {
      this.onResumed();
    }
  }

  _ensureDebuggerEnabledAndRefreshDebuggerId() {
    if (this.launchConfig.noDebug) {
      return this.debuggerReady.resolve();
    }

    // There is a bug in Chrome that does not retain debugger id
    // across cross-process navigations. Refresh it upon clearing contexts.
    this._cdp.Debugger.enable({}).then(response => {
      this.debuggerReady.resolve();
      if (response) {
        Thread._allThreadsByDebuggerId.set(response.debuggerId, this);
      }
    });
    this.exceptionPause.apply(this._cdp);
  }

  private async _onPaused(event: Cdp.Debugger.PausedEvent) {
    const hitBreakpoints = event.hitBreakpoints ?? [];
    // "Break on start" is not actually a by-spec reason in CDP, it's added on from Node.js, so cast `as string`:
    // https://github.com/nodejs/node/blob/9cbf6af5b5ace0cc53c1a1da3234aeca02522ec6/src/node_contextify.cc#L913
    // And Deno uses `debugCommand:
    // https://github.com/denoland/deno/blob/2703996dea73c496d79fcedf165886a1659622d1/core/inspector.rs#L571
    const isInspectBrk = (event.reason as string) === 'Break on start'
      || event.reason === 'debugCommand';
    const location = event.callFrames[0]?.location as Cdp.Debugger.Location | undefined;
    const scriptId = (event.data as IInstrumentationPauseAuxData)?.scriptId || location?.scriptId;
    const isSourceMapPause = scriptId
      && (event.reason === 'instrumentation'
        || this._breakpointManager.isEntrypointBreak(hitBreakpoints, scriptId)
        || hitBreakpoints.some(bp => this._pauseOnSourceMapBreakpointIds?.includes(bp)));
    this.evaluator.setReturnedValue(event.callFrames[0]?.returnValue);

    if (isSourceMapPause) {
      if (
        (this.launchConfig as IChromiumBaseConfiguration).perScriptSourcemaps === 'auto'
        && this._shouldEnablePerScriptSms(event)
      ) {
        await this._enablePerScriptSourcemaps();
      }

      if (event.data && !isInspectBrk) {
        event.data.__rewriteAs = 'breakpoint';
      }

      const expectedPauseReason = this._expectedPauseReason;
      if (scriptId && (await this._handleSourceMapPause(scriptId, location))) {
        // Pause if we just resolved a breakpoint that's on this
        // location; this won't have existed before now.
      } else if (isInspectBrk) {
        // Inspect-brk is handled later on
      } else if (await this.isCrossThreadStep(event)) {
        // Check if we're stepping into an async-loaded script (#223)
        event.data = { ...event.data, __rewriteAs: 'step' };
      } else if (
        await this._breakpointManager.shouldPauseAt(
          event,
          hitBreakpoints,
          this.target.entryBreakpoint,
          true,
        )
      ) {
        // Check if there are any user-defined breakpoints on this line
      } else if (expectedPauseReason?.reason === 'step') {
        // Check if we're in the middle of a step, e.g. stepping over a
        // function compilation. Stepping in should still remain paused,
        // and an instrumentation pause in step out should not be possible.
        if (expectedPauseReason.direction === StepDirection.In) {
          // no-op
        } else {
          return this._cdp.Debugger.resume({});
        }
      } else {
        // If none of this above, it's pure instrumentation.
        return this.resume();
      }
    } else {
      const wantsPause = event.reason === 'exception' || event.reason === 'promiseRejection'
        ? await this.exceptionPause.shouldPauseAt(event)
        : await this._breakpointManager.shouldPauseAt(
          event,
          hitBreakpoints,
          this.target.entryBreakpoint,
          false,
        );

      if (!wantsPause) {
        return this.resume();
      }
    }

    const stepInBreakpoint = this._waitingForStepIn?.intoTargetBreakpoint;
    if (stepInBreakpoint) {
      if (event.hitBreakpoints?.includes(stepInBreakpoint)) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this._waitingForStepIn!.intoTargetBreakpoint = undefined;
        await this._cdp.Debugger.removeBreakpoint({ breakpointId: stepInBreakpoint });
        await this._cdp.Debugger.stepInto({ breakOnAsyncCall: false });
      } else {
        this.resume();
      }

      return;
    }

    if (isInspectBrk) {
      if (
        // Continue if continueOnAttach is requested...
        ('continueOnAttach' in this.launchConfig && this.launchConfig.continueOnAttach)
        // Or if we're debugging an extension host...
        || this.launchConfig.type === DebugType.ExtensionHost
        // Or if the target is a worker_thread https://github.com/microsoft/vscode/issues/125451
        || this.target instanceof NodeWorkerTarget
      ) {
        this.resume();
        return;
      }
    }

    // We store pausedDetails in a local variable to avoid race conditions while awaiting this._smartStepper.shouldSmartStep
    const pausedDetails = (this._pausedDetails = await this._createPausedDetails(event));
    if (this._excludedCallers.length) {
      if (await this._matchesExcludedCaller(this._pausedDetails.stackTrace)) {
        this.logger.info(LogTag.Runtime, 'Skipping pause due to excluded caller');
        this.resume();
        return;
      }
    }

    const smartStepDirection = await this._smartStepper.getSmartStepDirection(
      pausedDetails,
      this._expectedPauseReason,
    );

    // avoid racing:
    if (this._pausedDetails !== pausedDetails) {
      return;
    }

    switch (smartStepDirection) {
      case StepDirection.In:
        return this.stepInto();
      case StepDirection.Out:
        return this.stepOut();
      case StepDirection.Over:
        return this.stepOver();
      default:
        // continue
    }

    this._waitingForStepIn = undefined;
    this._pausedVariables = this.replVariables.createDetached();

    await this._onThreadPaused(pausedDetails);
  }

  /**
   * Gets whether the stack trace should be skipped as a result of a caller
   * being excluded.
   *
   * This function is as lazy as possible. For example, we only unwrap the
   * first frame's source if the line and column match the target, and
   * load the stack sources incrementally in the same way.
   */
  private async _matchesExcludedCaller(trace: StackTrace): Promise<boolean> {
    if (!this._excludedCallers.length) {
      return false;
    }

    const firstFrame = trace.frames[0];
    const first = firstFrame instanceof StackFrame && (await firstFrame.uiLocation());
    if (!first) {
      return false;
    }

    let firstSource: Dap.Source | undefined;
    let stackLocations: (IUiLocation | undefined)[] | undefined;
    const stackAsDap: Dap.Source[] = []; // sparse array

    for (const { caller, target } of this._excludedCallers) {
      if (target.line !== first.lineNumber || target.column !== first.columnNumber) {
        continue;
      }

      firstSource ??= await first.source.toDap();
      if (!sourcesEqual(firstSource, target.source)) {
        continue;
      }

      if (!stackLocations) {
        // for some reason, if this is assigned directly to stackLocations,
        // then TS will think it can still be undefined below
        const x = await trace.loadFrames(excludedCallerSearchDepth).then(frames =>
          Promise.all(
            frames
              .slice(1)
              .filter(isInstanceOf(StackFrame))
              .map(f => f.uiLocation()),
          )
        );
        stackLocations = x;
      }

      for (let i = 0; i < stackLocations.length; i++) {
        const r = stackLocations[i];
        if (!r || r.lineNumber !== caller.line || r.columnNumber !== caller.column) {
          continue;
        }

        const source = (stackAsDap[i] ??= await r.source.toDap());
        if (sourcesEqual(source, caller.source)) {
          return true;
        }
      }
    }

    return false;
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

  /**
   * @inheritdoc
   */
  async dispose() {
    await this.shutdown.shutdownAll();
    this.disposed = true;

    for (const [debuggerId, thread] of Thread._allThreadsByDebuggerId) {
      if (thread === this) Thread._allThreadsByDebuggerId.delete(debuggerId);
    }

    this._removeAllScripts(true /* silent */);
    this._executionContextsCleared();

    // Send 'exited' after all other thread-releated events
    await this._dap.with(dap =>
      dap.thread({
        reason: 'exited',
        threadId: this.id,
      })
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
        lineNumber: Math.max(0, loc.location.lineNumber) + 1,
        columnNumber: Math.max(0, loc.location.columnNumber || 0) + 1,
        scriptId: loc.location.scriptId,
      };
    }
    return {
      lineNumber: Math.max(0, location.lineNumber) + 1,
      columnNumber: Math.max(0, location.columnNumber || 0) + 1,
      scriptId: location.scriptId,
    };
  }

  /**
   * Gets the UI location given the raw location from the runtime. We make
   * an effort to avoid async/await in the happy path here, since this function
   * can get very hot in some scenarios.
   */
  public rawLocationToUiLocation(
    rawLocation: RawLocation,
  ): Promise<IPreferredUiLocation | undefined> | IPreferredUiLocation | undefined {
    // disposed check from https://github.com/microsoft/vscode/issues/121136
    if (!rawLocation.scriptId || this.disposed) {
      return undefined;
    }

    // Locations are never possible if the debugger is not enabled.
    if (this.launchConfig.noDebug) {
      return undefined;
    }

    const script = this._sourceContainer.getScriptById(rawLocation.scriptId);
    if (!script) {
      return this.rawLocationToUiLocationWithWaiting(rawLocation);
    }

    if (script.resolvedSource) {
      return this._sourceContainer.preferredUiLocation({
        ...script.resolvedSource.offsetScriptToSource(rawLocation),
        source: script.resolvedSource,
      });
    } else {
      return script.source.then(source =>
        this._sourceContainer.preferredUiLocation({
          ...source.offsetSourceToScript(rawLocation),
          source,
        })
      );
    }
  }

  public async rawLocationToUiLocationWithWaiting(
    rawLocation: RawLocation,
  ): Promise<IPreferredUiLocation | undefined> {
    const script = rawLocation.scriptId
      ? await this.getScriptByIdOrWait(rawLocation.scriptId)
      : undefined;
    if (!script) {
      return;
    }

    const source = await script.source;
    return this._sourceContainer.preferredUiLocation({
      ...source.offsetScriptToSource(rawLocation),
      source,
    });
  }

  public getScriptById(scriptId: string) {
    const script = this._sourceContainer.getScriptById(scriptId);
    return script;
  }

  /**
   * Gets a script ID if it exists, or waits to up maxTime. In rare cases we
   * can get a request (like a stacktrace request) from DAP before Chrome
   * finishes passing its sources over. We *should* normally know about all
   * possible script IDs; this waits if we see one that we don't.
   */
  private getScriptByIdOrWait(scriptId: string, maxTime = 500) {
    const script = this._sourceContainer.getScriptById(scriptId);
    return script || this.waitForScriptId(scriptId, maxTime);
  }

  private waitForScriptId(scriptId: string, maxTime: number) {
    return new Promise<Script | undefined>(resolve => {
      const listener = this._sourceContainer.onScript(script => {
        if (script.scriptId === scriptId) {
          resolve(script);
          listener.dispose();
          clearTimeout(timeout);
        }
      });

      const timeout = setTimeout(() => {
        resolve(undefined);
        listener.dispose();
      }, maxTime);
    });
  }

  async renderDebuggerLocation(loc: Cdp.Debugger.Location): Promise<string> {
    const raw = this.rawLocation(loc);
    const ui = await this.rawLocationToUiLocation(raw);
    if (ui) return `@ ${await ui.source.prettyName()}:${ui.lineNumber}`;
    return `@ VM${raw.scriptId || 'XX'}:${raw.lineNumber}`;
  }

  async updateCustomBreakpoints(xhr: string[], events: string[]): Promise<void> {
    if (!this.target.supportsCustomBreakpoints()) return;
    this._enabledCustomBreakpoints ??= new Set();

    // Do not fail for custom breakpoints, to account for
    // future changes in cdp vs stale breakpoints saved in the workspace.
    const newIds = new Set<string>();
    for (const x of xhr) {
      newIds.add(CustomBreakpointPrefix.XHR + x);
    }
    for (const e of events) {
      newIds.add(CustomBreakpointPrefix.Event + e);
    }
    const todo: (Promise<unknown> | undefined)[] = [];

    for (const newId of newIds) {
      if (!this._enabledCustomBreakpoints.has(newId)) {
        const id = newId.slice(CustomBreakpointPrefix.XHR.length);
        todo.push(
          newId.startsWith(CustomBreakpointPrefix.XHR)
            ? this._cdp.DOMDebugger.setXHRBreakpoint({ url: id })
            : customBreakpoints().get(id)?.apply(this._cdp, true),
        );
      }
    }
    for (const oldId of this._enabledCustomBreakpoints) {
      if (!newIds.has(oldId)) {
        const id = oldId.slice(CustomBreakpointPrefix.XHR.length);
        todo.push(
          oldId.startsWith(CustomBreakpointPrefix.XHR)
            ? this._cdp.DOMDebugger.removeXHRBreakpoint({ url: id })
            : customBreakpoints().get(id)?.apply(this._cdp, false),
        );
      }
    }

    this._enabledCustomBreakpoints = newIds;
    await Promise.all(todo);
  }

  private async _createPausedDetails(event: Cdp.Debugger.PausedEvent): Promise<IPausedDetails> {
    // When hitting breakpoint in compiled source, we ignore source maps during the stepping
    // sequence (or exceptions) until user resumes or hits another breakpoint-alike pause.
    // TODO: this does not work for async stepping just yet.
    const sameDebuggingSequence = event.reason === 'assert'
      || event.reason === 'exception'
      || event.reason === 'promiseRejection'
      || event.reason === 'other'
      || event.reason === 'ambiguous';

    const hitBreakpoints =
      event.hitBreakpoints?.filter(bp => !this._breakpointManager.isEntrypointCdpBreak(bp)) || [];

    if (hitBreakpoints.length || !sameDebuggingSequence) {
      this._sourceContainer.clearDisabledSourceMaps();
    }

    if (event.hitBreakpoints && this._sourceMapDisabler) {
      for (const sourceToDisable of this._sourceMapDisabler(event.hitBreakpoints)) {
        this._sourceContainer.disableSourceMapForSource(sourceToDisable);
      }
    }

    const stackTrace = StackTrace.fromDebugger(
      this,
      event.callFrames,
      event.asyncStackTrace,
      event.asyncStackTraceId,
    );

    if (event.data?.__rewriteAs === 'breakpoint') {
      return {
        thread: this,
        event,
        stackTrace,
        reason: 'breakpoint',
        description: l10n.t('Paused on breakpoint'),
      };
    }

    if (event.data?.__rewriteAs === 'step') {
      return {
        thread: this,
        event,
        stackTrace,
        reason: 'step',
        description: l10n.t('Paused'),
      };
    }

    switch (event.reason) {
      case 'assert':
        return {
          thread: this,
          event,
          stackTrace,
          reason: 'exception',
          description: l10n.t('Paused on assert'),
        };
      case 'debugCommand':
        return {
          thread: this,
          event,
          stackTrace,
          reason: 'pause',
          description: l10n.t('Paused on debug() call'),
        };
      case 'DOM':
        return {
          thread: this,
          event,
          stackTrace,
          reason: 'data breakpoint',
          description: l10n.t('Paused on DOM breakpoint'),
        };
      case 'EventListener':
        return this._resolveEventListenerBreakpointDetails(stackTrace, event);
      case 'exception':
        return {
          thread: this,
          event,
          stackTrace,
          reason: 'exception',
          description: l10n.t('Paused on exception'),
          exception: event.data as Cdp.Runtime.RemoteObject | undefined,
        };
      case 'promiseRejection':
        return {
          thread: this,
          event,
          stackTrace,
          reason: 'exception',
          description: l10n.t('Paused on {0}', 'promise rejection'),
          exception: event.data as Cdp.Runtime.RemoteObject | undefined,
        };
      case 'instrumentation':
        if (event.data && event.data['scriptId']) {
          return {
            thread: this,
            event,
            stackTrace,
            reason: 'step',
            description: l10n.t('Paused'),
          };
        }
        return {
          thread: this,
          event,
          stackTrace,
          reason: 'function breakpoint',
          description: l10n.t('Paused on instrumentation breakpoint'),
        };
      case 'XHR':
        return {
          thread: this,
          event,
          stackTrace,
          reason: 'data breakpoint',
          description: l10n.t('Paused on XMLHttpRequest or fetch'),
        };
      case 'OOM':
        return {
          thread: this,
          event,
          stackTrace,
          reason: 'exception',
          description: l10n.t('Paused before Out Of Memory exception'),
        };
      default:
        if (hitBreakpoints.length) {
          let isStopOnEntry = false; // By default we assume breakpoints aren't stop on entry
          const userEntryBp = this.target.entryBreakpoint;
          if (userEntryBp && hitBreakpoints.includes(userEntryBp.cdpId)) {
            isStopOnEntry = true; // But if it matches the entry breakpoint id, then it's probably stop on entry
            const entryBreakpointSource = this._sourceContainer.source({
              path: fileUrlToAbsolutePath(userEntryBp.path),
            });

            if (entryBreakpointSource !== undefined) {
              const entryBreakpointLocations = await this._sourceContainer
                .currentSiblingUiLocations({
                  lineNumber: event.callFrames[0].location.lineNumber + 1,
                  columnNumber: (event.callFrames[0].location.columnNumber || 0) + 1,
                  source: entryBreakpointSource,
                });

              // But if there is a user breakpoint on the same location that the stop on entry breakpoint, then we consider it an user breakpoint
              isStopOnEntry = !entryBreakpointLocations?.some(location =>
                this._breakpointManager.hasAtLocation(location)
              );
            }
          }

          if (!isStopOnEntry) {
            this._breakpointManager.registerBreakpointsHit(hitBreakpoints);
          }
          return {
            thread: this,
            event,
            stackTrace,
            hitBreakpoints: event.hitBreakpoints,
            reason: isStopOnEntry ? 'entry' : 'breakpoint',
            description: l10n.t('Paused on breakpoint'),
          };
        }
        if (this._expectedPauseReason) {
          return {
            thread: this,
            event,
            stackTrace,
            description: l10n.t('Paused'),
            ...this._expectedPauseReason,
          };
        }
        return {
          thread: this,
          event,
          stackTrace,
          reason: 'pause',
          description: l10n.t('Paused on debugger statement'),
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
        event,
        stackTrace,
        reason: 'function breakpoint',
        description: details.short,
        text: details.long,
      };
    }
    return {
      thread: this,
      event,
      stackTrace,
      reason: 'function breakpoint',
      description: l10n.t('Paused on event listener'),
    };
  }

  _clearDebuggerConsole(): Dap.OutputEventParams {
    return {
      category: 'console',
      output: '\x1b[2J',
    };
  }

  private _removeAllScripts(silent = false) {
    this._sourceContainer.clear(silent);
  }

  private _onScriptParsed(event: Cdp.Debugger.ScriptParsedEvent) {
    const sourceScript: Script | ISourceScript = {
      url: event.url,
      hasSourceURL: !!event.hasSourceURL,
      embedderName: event.embedderName,
      scriptId: event.scriptId,
      executionContextId: event.executionContextId,
    };

    // normalize paths paths that old Electron versions can add (#1099)
    if (urlUtils.isAbsolute(event.url)) {
      event.url = urlUtils.absolutePathToFileUrl(event.url);
    }

    const existing = this._sourceContainer.getScriptById(event.scriptId);
    if (existing && this._executionContexts.has(existing.executionContextId)) {
      return;
    }

    if (event.url.endsWith(sourceUtils.SourceConstants.InternalExtension)) {
      this._sourceContainer.addScriptById(sourceScript);
      // The customer doesn't care about the internal cdp files, so skip this event
      return;
    }

    if (event.url) {
      event.url = this.target.scriptUrlToUrl(event.url);
    }

    // Hack: Node 16 seems to not report its 0th context where it loads some
    // initial scripts. Pretend these are actually loaded in the 2nd (main) context.
    // https://github.com/nodejs/node/issues/47438
    // Hack: Blazor misreports its execution context IDs too
    // https://github.com/dotnet/runtime/issues/86754
    // So just make execution context ID's if they're missing.
    let executionContext = this._executionContexts.get(event.executionContextId);
    if (!executionContext) {
      this.logger.info(LogTag.Internal, 'Creating missing execution context id', event);
      executionContext = new ExecutionContext({
        id: event.executionContextId,
        name: '<autofilled>',
        origin: '',
        uniqueId: String(event.executionContextId),
      });
      this._executionContexts.set(event.executionContextId, executionContext);
    }

    const createSource = async () => {
      const prevSource = this._sourceContainer.getSourceByOriginalUrl(event.url);
      if (event.hash && prevSource?.contentHash === event.hash) {
        prevSource.addScript({
          scriptId: event.scriptId,
          url: event.url,
          embedderName: event.embedderName,
          hasSourceURL: !!event.hasSourceURL,
          executionContextId: event.executionContextId,
        });
        return prevSource;
      }

      const contentGetter = async () => {
        const response = await this._cdp.Debugger.getScriptSource({ scriptId: event.scriptId });
        return response ? response.scriptSource : undefined;
      };

      const inlineSourceOffset = event.startLine || event.startColumn
        ? { lineOffset: event.startLine, columnOffset: event.startColumn }
        : undefined;

      // see https://github.com/microsoft/vscode/issues/103027
      const runtimeScriptOffset = event.url.endsWith('#vscode-extension')
        ? { lineOffset: 2, columnOffset: 0 }
        : undefined;

      let resolvedSourceMapUrl: string | undefined;
      if (event.sourceMapURL) {
        // Note: we should in theory refetch source maps with relative urls, if the base url has changed,
        // but in practice that usually means new scripts with new source maps anyway.
        resolvedSourceMapUrl = urlUtils.isDataUri(event.sourceMapURL)
          ? event.sourceMapURL
          : (event.url && urlUtils.completeUrl(event.url, event.sourceMapURL)) || event.url;
        if (!resolvedSourceMapUrl) {
          this._dap.with(dap =>
            errors.reportToConsole(dap, `Could not load source map from ${event.sourceMapURL}`)
          );
        }
      }

      const source = await this._sourceContainer.addSource(
        event,
        contentGetter,
        resolvedSourceMapUrl,
        inlineSourceOffset,
        runtimeScriptOffset,
        // only include the script hash if content validation is enabled, and if
        // the source does not have a redirected URL. In the latter case the
        // original file won't have a `# sourceURL=...` comment, so the hash
        // never matches: https://github.com/microsoft/vscode-js-debug/issues/1476
        !event.hasSourceURL && this.launchConfig.enableContentValidation ? event.hash : undefined,
      );

      source.addScript({
        scriptId: event.scriptId,
        url: event.url,
        embedderName: event.embedderName,
        hasSourceURL: !!event.hasSourceURL,
        executionContextId: event.executionContextId,
      });

      return source;
    };

    const script: Script = { ...sourceScript, source: createSource() };
    script.source.then(s => (script.resolvedSource = s));
    executionContext.scripts.push(script);

    this._sourceContainer.addScriptById(script);

    if (event.sourceMapURL || event.scriptLanguage === 'WebAssembly') {
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
  async _handleSourceMapPause(
    scriptId: string,
    brokenOn?: Cdp.Debugger.Location,
  ): Promise<boolean> {
    this._pausedForSourceMapScriptId = scriptId;
    const perScriptTimeout = this._sourceContainer.sourceMapTimeouts().sourceMapMinPause;
    const timeout = perScriptTimeout
      + this._sourceContainer.sourceMapTimeouts().sourceMapCumulativePause;

    const script = this._sourceContainer.getScriptById(scriptId);
    if (!script) {
      this._pausedForSourceMapScriptId = undefined;
      return false;
    }

    const timer = new HrTime();
    const result = await Promise.race([this._getOrStartLoadingSourceMaps(script), delay(timeout)]);

    const timeSpentWallClockInMs = timer.elapsed().ms;
    const sourceMapCumulativePause =
      this._sourceContainer.sourceMapTimeouts().sourceMapCumulativePause
      - Math.max(timeSpentWallClockInMs - perScriptTimeout, 0);
    this._sourceContainer.setSourceMapTimeouts({
      ...this._sourceContainer.sourceMapTimeouts(),
      sourceMapCumulativePause,
    });
    this.logger.verbose(LogTag.Internal, `Blocked execution waiting for source-map`, {
      timeSpentWallClockInMs,
      sourceMapCumulativePause,
    });

    if (!result) {
      this._dap.with(dap =>
        dap.output({
          category: 'stderr',
          output: l10n.t(
            'WARNING: Processing source-maps of {0} took longer than {1} ms so we continued execution without waiting for all the breakpoints for the script to be set.',
            script.url || script.scriptId,
            timeout,
          ),
        })
      );
    }

    console.assert(this._pausedForSourceMapScriptId === scriptId);
    this._pausedForSourceMapScriptId = undefined;

    const bLine = brokenOn?.lineNumber || 0;
    const bColumn = brokenOn?.columnNumber;

    return !!result
      ?.map(base1To0)
      .some(b => b.lineNumber === bLine && (bColumn === undefined || bColumn === b.columnNumber));
  }

  /**
   * Loads sourcemaps for the given script and invokes the handler, if we
   * haven't already done so. Returns a promise that resolves with the
   * handler's results.
   */
  private _getOrStartLoadingSourceMaps(script: Script) {
    const ctx = this._executionContexts.get(script.executionContextId);
    if (!ctx) {
      return Promise.resolve([]);
    }

    const existing = ctx.sourceMapLoads.get(script.scriptId);
    if (existing) {
      return existing;
    }

    const result = script.source
      .then(source => this._sourceContainer.waitForSourceMapSources(source))
      .then(sources =>
        sources.length && this._scriptWithSourceMapHandler
          ? this._scriptWithSourceMapHandler(script, sources)
          : []
      );

    ctx.sourceMapLoads.set(script.scriptId, result);
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
        p.name !== '[[FunctionLocation]]'
        || !p.value
        || (p.value.subtype as string) !== 'internal#location'
      ) {
        continue;
      }
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
        dap.copyRequested({ text: objectPreview.previewRemoteObject(object, 'copy') })
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

  private async _onThreadPaused(details: IPausedDetails) {
    this._expectedPauseReason = undefined;
    this._onPausedEmitter.fire(details);
    let hitBreakpointIds: number[] | undefined;

    // If we hit breakpoints, try to make sure they all get resolved before we
    // send the event to the UI. This should generally only happen if the UI
    // bulk-set breakpoints and some resolve faster than others, since we expect
    // the CDP in turn will tell *us* they're resolved before hitting them.
    if (details.hitBreakpoints) {
      hitBreakpointIds = await Promise.race([
        delay(1000).then(() => undefined),
        Promise.all(
          details.hitBreakpoints
            .map(bp => this._breakpointManager._resolvedBreakpoints.get(bp))
            .filter(isInstanceOf(UserDefinedBreakpoint))
            .map(r => r.untilSetCompleted().then(() => r.dapId)),
        ),
      ]);
    }

    // slight hack: it's possible for the debugee to respond very quickly to
    // a "continue" or "step" request and before the response to that is
    // sent. Add a 0ms delay so all micotasks have a chance to process
    // before we send the stopped() event.
    await delay(0);

    this._dap.with(dap =>
      dap.stopped({
        reason: details.reason as Dap.StoppedEventParams['reason'],
        description: details.description,
        threadId: this.id,
        text: details.text,
        hitBreakpointIds,
        allThreadsStopped: false,
      })
    );
  }

  private _onThreadResumed() {
    this._dap.with(dap =>
      dap.continued({
        threadId: this.id,
        allThreadsContinued: false,
      })
    );
  }

  /**
   * Returns whether the pause event is (probably) from a cross-thread step.
   * @see https://github.com/microsoft/vscode-js-debug/issues/223
   */
  private isCrossThreadStep(event: Cdp.Debugger.PausedEvent) {
    if (!event.asyncStackTraceId || !event.asyncStackTraceId.debuggerId) {
      return false;
    }

    const parent = Thread.threadForDebuggerId(event.asyncStackTraceId.debuggerId);
    if (!parent || !parent._waitingForStepIn?.lastDetails) {
      return false;
    }

    const originalStack = parent._waitingForStepIn.lastDetails.stackTrace;
    return parent._cdp.Debugger.getStackTrace({ stackTraceId: event.asyncStackTraceId }).then(
      trace => {
        if (!trace || !trace.stackTrace.callFrames.length) {
          return false;
        }

        const parentFrame = StackFrame.fromRuntime(parent, trace.stackTrace.callFrames[0], false);
        if (!parentFrame.equivalentTo(originalStack.frames[0])) {
          return false;
        }

        parent._waitingForStepIn = undefined;
        return true;
      },
    );
  }

  /**
   * Based on whether `pause` is true, sets or unsets an instrumentation
   * breakpoint in the runtime that is hit before sources with scripts.
   * Returns true if the breakpoint was able to be set, which is usually
   * (always?) `false` in Node runtimes.
   */
  public async setScriptSourceMapHandler(
    pause: boolean,
    handler?: ScriptWithSourceMapHandler,
  ): Promise<boolean> {
    this._scriptWithSourceMapHandler = handler;

    const needsPause = pause && this._sourceContainer.sourceMapTimeouts().sourceMapMinPause
      && handler;
    if (needsPause && !this._pauseOnSourceMapBreakpointIds?.length) {
      // setting the URL breakpoint for wasm fails if debugger isn't fully initialized
      await this.debuggerReady.promise;

      const result = await Promise.all([
        this._cdp.Debugger.setInstrumentationBreakpoint({
          instrumentation: 'beforeScriptWithSourceMapExecution',
        }),
        // WASM files don't have sourcemaps and so aren't paused in the usual
        // instrumentation BP. But we do need to pause, either to figure out the WAT
        // lines or by mapping symbolicated files.
        //
        // todo: this does not actually work yet! I have a thread out with the
        // Chromium folks to see if we can make it work, or if there's another workaround.
        this._cdp.Debugger.setBreakpointByUrl({
          lineNumber: 0,
          columnNumber: 0,
          // this is very approximate, but hitting it spurriously is not problematic
          urlRegex: '\\.[wW][aA][sS][mM]',
        }),
      ]);
      this._pauseOnSourceMapBreakpointIds = result.map(r => r?.breakpointId).filter(truthy);
    } else if (!needsPause && this._pauseOnSourceMapBreakpointIds?.length) {
      const breakpointIds = this._pauseOnSourceMapBreakpointIds;
      this._pauseOnSourceMapBreakpointIds = undefined;
      await Promise.all(
        breakpointIds.map(breakpointId => this._cdp.Debugger.removeBreakpoint({ breakpointId })),
      );
    }

    return !!this._pauseOnSourceMapBreakpointIds?.length;
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
  private async _enablePerScriptSourcemaps() {
    await this._breakpointManager.updateEntryBreakpointMode(this, EntryBreakpointMode.Greedy);
    await this.setScriptSourceMapHandler(false, this._scriptWithSourceMapHandler);
  }

  private _shouldEnablePerScriptSms(event: Cdp.Debugger.PausedEvent) {
    const script = this._sourceContainer.getScriptById(event.callFrames[0]?.location.scriptId);
    if (!script) {
      return false;
    }

    if (script.url.includes('@vite/client')) {
      return true;
    }

    if (event.reason !== 'instrumentation' || !urlUtils.isDataUri(event.data?.sourceMapURL)) {
      return false;
    }

    return script.url.startsWith('webpack') || script.url.startsWith('ng:');
  }

  setSourceMapDisabler(sourceMapDisabler?: SourceMapDisabler) {
    this._sourceMapDisabler = sourceMapDisabler;
  }

  static threadForDebuggerId(debuggerId: Cdp.Runtime.UniqueDebuggerId): Thread | undefined {
    return Thread._allThreadsByDebuggerId.get(debuggerId);
  }

  /**
   * Replaces locations in the stack trace with their source locations.
   */
  public async replacePathsInStackTrace(trace: string): Promise<string> {
    const todo: (string | Promise<string>)[] = [];
    for (const chunk of new StackTraceParser(trace)) {
      if (typeof chunk === 'string') {
        todo.push(chunk);
        continue;
      }

      const compiledSource =
        this._sourceContainer.getSourceByOriginalUrl(urlUtils.absolutePathToFileUrl(chunk.path))
        || this._sourceContainer.getSourceByOriginalUrl(chunk.path);
      if (!compiledSource) {
        todo.push(chunk.toString());
        continue;
      }

      todo.push(
        this._sourceContainer
          .preferredUiLocation({
            columnNumber: chunk.position.base1.columnNumber,
            lineNumber: chunk.position.base1.lineNumber,
            source: compiledSource,
          })
          .then(
            ({ source, lineNumber, columnNumber }) =>
              `${source.absolutePath}:${lineNumber}:${columnNumber}`,
          ),
      );
    }

    const mapped = await Promise.all(todo);
    return mapped.join('');
  }
}
