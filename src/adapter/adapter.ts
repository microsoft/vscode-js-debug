/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as ts from 'typescript';
import * as nls from 'vscode-nls';
import Cdp from '../cdp/api';
import Dap from '../dap/api';
import { BreakpointManager } from './breakpoints';
import * as completions from './completions';
import { Configurator } from './configurator';
import * as errors from './errors';
import * as objectPreview from './objectPreview';
import { Location, SourceContainer, SourcePathResolver } from './sources';
import { StackFrame } from './stackTrace';
import { ExecutionContextTree, Thread, ThreadManager } from './threads';
import { VariableStore } from './variables';

const localize = nls.loadMessageBundle();
const threadForSourceRevealId = 9999999999999;

type EvaluatePrep = {
  variableStore: VariableStore;
  thread: Thread;
  stackFrame?: StackFrame;
  executionContextId?: number;
};

export class Adapter {
  readonly threadManager: ThreadManager;
  readonly sourceContainer: SourceContainer;

  private _dap: Dap.Api;
  private _breakpointManager: BreakpointManager;
  private _currentExecutionContext: ExecutionContextTree | undefined;
  private _locationToReveal: Location | undefined;

  constructor(dap: Dap.Api, sourcePathResolver: SourcePathResolver) {
    this._dap = dap;
    this._dap.on('threads', params => this._onThreads(params));
    this._dap.on('continue', params => this._onContinue(params));
    this._dap.on('pause', params => this._onPause(params));
    this._dap.on('next', params => this._onNext(params));
    this._dap.on('stepIn', params => this._onStepIn(params));
    this._dap.on('stepOut', params => this._onStepOut(params));
    this._dap.on('restartFrame', params => this._onRestartFrame(params));
    this._dap.on('stackTrace', params => this._onStackTrace(params));
    this._dap.on('scopes', params => this._onScopes(params));
    this._dap.on('variables', params => this._onVariables(params));
    this._dap.on('evaluate', params => this._onEvaluate(params));
    this._dap.on('completions', params => this._onCompletions(params));
    this._dap.on('loadedSources', params => this._onLoadedSources(params));
    this._dap.on('source', params => this._onSource(params));
    this._dap.on('setBreakpoints', params => this._onSetBreakpoints(params));
    this._dap.on('setExceptionBreakpoints', params => this._onSetExceptionBreakpoints(params));
    this._dap.on('exceptionInfo', params => this._onExceptionInfo(params));
    this._dap.on('setVariable', params => this._onSetVariable(params));

    this.sourceContainer = new SourceContainer(this._dap, sourcePathResolver);
    this.threadManager = new ThreadManager(this._dap, sourcePathResolver, this.sourceContainer);
    this._breakpointManager = new BreakpointManager(this._dap, sourcePathResolver, this.sourceContainer, this.threadManager);
  }

  async configure(configurator: Configurator): Promise<void> {
    await this.threadManager.setPauseOnExceptionsState(configurator.pausedOnExceptionsState());
    for (const request of configurator.setBreakpointRequests())
      await this._breakpointManager.setBreakpoints(request.params, request.generatedIds);
  }

  _threadNotAvailableError(): Dap.Error {
    return errors.createSilentError(localize('error.threadNotFound', 'Thread not found'));
  }

  async _onThreads(_: Dap.ThreadsParams): Promise<Dap.ThreadsResult | Dap.Error> {
    const threads = this.threadManager.threadLabels();
    if (this._locationToReveal)
      threads.push({ id: threadForSourceRevealId, name: '' });
    return { threads };
  }

  async _onContinue(params: Dap.ContinueParams): Promise<Dap.ContinueResult | Dap.Error> {
    const thread = this.threadManager.thread(params.threadId);
    if (!thread)
      return this._threadNotAvailableError();
    if (!await thread.resume())
      return errors.createSilentError(localize('error.resumeDidFail', 'Unable to resume'));
    return { allThreadsContinued: false };
  }

  async _onPause(params: Dap.PauseParams): Promise<Dap.PauseResult | Dap.Error> {
    const thread = this.threadManager.thread(params.threadId);
    if (!thread)
      return this._threadNotAvailableError();
    if (!await thread.pause())
      return errors.createSilentError(localize('error.pauseDidFail', 'Unable to pause'));
    return {};
  }

  async _onNext(params: Dap.NextParams): Promise<Dap.NextResult | Dap.Error> {
    const thread = this.threadManager.thread(params.threadId);
    if (!thread)
      return this._threadNotAvailableError();
    if (!await thread.stepOver())
      return errors.createSilentError(localize('error.stepOverDidFail', 'Unable to step next'));
    return {};
  }

  async _onStepIn(params: Dap.StepInParams): Promise<Dap.StepInResult | Dap.Error> {
    const thread = this.threadManager.thread(params.threadId);
    if (!thread)
      return this._threadNotAvailableError();
    if (!await thread.stepInto())
      return errors.createSilentError(localize('error.stepInDidFail', 'Unable to step in'));
    return {};
  }

  async _onStepOut(params: Dap.StepOutParams): Promise<Dap.StepOutResult | Dap.Error> {
    const thread = this.threadManager.thread(params.threadId);
    if (!thread)
      return this._threadNotAvailableError();
    if (!await thread.stepOut())
      return errors.createSilentError(localize('error.stepOutDidFail', 'Unable to step out'));
    return {};
  }

  async _onRestartFrame(params: Dap.RestartFrameParams): Promise<Dap.RestartFrameResult | Dap.Error> {
    const stackFrame = this._findStackFrame(params.frameId);
    if (!stackFrame)
      return errors.createSilentError(localize('error.stackFrameNotFound', 'Stack frame not found'));
    if (!stackFrame.thread().restartFrame(stackFrame))
      return errors.createUserError(localize('error.restartFrameAsync', 'Cannot restart asynchronous frame'));
    return {};
  }

  async _onStackTrace(params: Dap.StackTraceParams): Promise<Dap.StackTraceResult | Dap.Error> {
    if (params.threadId === threadForSourceRevealId)
      return this._syntheticStackTraceForSourceReveal(params);
    const thread = this.threadManager.thread(params.threadId);
    if (!thread)
      return this._threadNotAvailableError();
    const details = thread.pausedDetails();
    if (!details)
      return errors.createSilentError(localize('error.threadNotPaused', 'Thread is not paused'));
    return details.stackTrace.toDap(params);
  }

  _findStackFrame(frameId: number): StackFrame | undefined {
    for (const thread of this.threadManager.threads()) {
      const details = thread.pausedDetails();
      if (!details)
        continue;
      const stackFrame = details.stackTrace.frame(frameId);
      if (stackFrame)
        return stackFrame;
    }
    return undefined;
  }

  async _onScopes(params: Dap.ScopesParams): Promise<Dap.ScopesResult | Dap.Error> {
    const stackFrame = this._findStackFrame(params.frameId);
    if (!stackFrame)
      return errors.createSilentError(localize('error.stackFrameNotFound', 'Stack frame not found'));
    return stackFrame.scopes();
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

  _prepareForEvaluate(frameId?: number): { result?: EvaluatePrep, error?: Dap.Error } {
    if (frameId !== undefined) {
      const stackFrame = this._findStackFrame(frameId);
      if (!stackFrame)
        return { error: errors.createSilentError(localize('error.stackFrameNotFound', 'Stack frame not found')) };
      if (!stackFrame.callFrameId())
        return { error: errors.createSilentError(localize('error.evaluateOnAsyncStackFrame', 'Unable to evaluate on async stack frame')) };

      const variableStore = stackFrame.thread().pausedVariables()!;
      return {
        result: {
          stackFrame,
          variableStore,
          thread: stackFrame.thread(),
        }
      };
    } else {
      let thread: Thread | undefined;
      let executionContextId: number | undefined;
      if (this._currentExecutionContext) {
        executionContextId = this._currentExecutionContext.contextId;
        thread = this.threadManager.thread(this._currentExecutionContext.threadId);
      } else {
        thread = this.threadManager.mainThread();
        const defaultContext = thread ? thread.defaultExecutionContext() : undefined;
        executionContextId = defaultContext ? defaultContext.id : undefined;
      }
      if (!thread || !executionContextId)
        return { error: this._threadNotAvailableError() };

      return {
        result: {
          variableStore: thread.replVariables,
          thread,
          executionContextId
        }
      };
    }
  }

  async _onEvaluate(args: Dap.EvaluateParams): Promise<Dap.EvaluateResult | Dap.Error> {
    const { result: maybePrep, error } = this._prepareForEvaluate(args.frameId);
    if (error)
      return error;
    const prep = maybePrep as EvaluatePrep;

    const params: Cdp.Runtime.EvaluateParams = {
      expression: args.expression,
      includeCommandLineAPI: true,
      objectGroup: 'console',
      generatePreview: true,
      throwOnSideEffect: args.context === 'hover' ? true : undefined,
      timeout: args.context === 'hover' ? 500 : undefined,
    };
    if (args.context === 'repl') {
      params.expression = this._wrapObjectLiteral(params.expression);
      if (params.expression.indexOf('await') !== -1) {
        const rewritten = this.rewriteTopLevelAwait(params.expression);
        if (rewritten) {
          params.expression = rewritten;
          params.awaitPromise = true;
        }
      }
    }

    const response = prep.stackFrame
      ? await prep.thread.cdp().Debugger.evaluateOnCallFrame({ ...params, callFrameId: prep.stackFrame.callFrameId()! })
      : await prep.thread.cdp().Runtime.evaluate({ ...params, contextId: prep.executionContextId });
    if (!response)
      return errors.createSilentError(localize('error.evaluateDidFail', 'Unable to evaluate'));

    if (args.context !== 'repl') {
      const variable = await prep.variableStore.createVariable(response.result, args.context);
      return {
        type: response.result.type,
        result: variable.value,
        variablesReference: variable.variablesReference,
        namedVariables: variable.namedVariables,
        indexedVariables: variable.indexedVariables,
      };
    }

    const outputSlot = prep.thread.claimOutputSlot();
    if (response.exceptionDetails) {
      outputSlot(await prep.thread.formatException(response.exceptionDetails, '↳ '));
    } else {
      const text = '\x1b[32m↳ ' + objectPreview.previewRemoteObject(response.result) + '\x1b[0m';
      const variablesReference = await prep.thread.replVariables.createVariableForOutput(text, [response.result]);
      const output = {
        category: 'stdout',
        output: '',
        variablesReference,
      } as Dap.OutputEventParams;
      outputSlot(output);
    }

    return { result: '', variablesReference: 0 };
  }

  async _onCompletions(params: Dap.CompletionsParams): Promise<Dap.CompletionsResult | Dap.Error> {
    const { result: maybePrep, error } = this._prepareForEvaluate(params.frameId);
    if (error)
      return error;
    const prep = maybePrep as EvaluatePrep;
    const line = params.line === undefined ? 0 : params.line - 1;
    return { targets: await completions.completions(prep.thread.cdp(), prep.executionContextId, prep.stackFrame, params.text, line, params.column) };
  }

  async _onLoadedSources(_: Dap.LoadedSourcesParams): Promise<Dap.LoadedSourcesResult> {
    return { sources: await Promise.all(this.sourceContainer.sources().map(source => source.toDap())) };
  }

  async _onSource(params: Dap.SourceParams): Promise<Dap.SourceResult | Dap.Error> {
    const source = this.sourceContainer.source(params.source!);
    if (!source)
      return errors.createSilentError(localize('error.sourceNotFound', 'Source not found'));
    const content = await source.content();
    if (content === undefined)
      return errors.createSilentError(localize('error.sourceContentDidFail', 'Unable to retrieve source content'));
    return { content, mimeType: source.mimeType() };
  }

  async _onSetBreakpoints(params: Dap.SetBreakpointsParams): Promise<Dap.SetBreakpointsResult | Dap.Error> {
    return this._breakpointManager.setBreakpoints(params);
  }

  async _onSetExceptionBreakpoints(params: Dap.SetExceptionBreakpointsParams): Promise<Dap.SetExceptionBreakpointsResult> {
    this.threadManager.setPauseOnExceptionsState(Configurator.resolvePausedOnExceptionsState(params));
    return {};
  }

  async _onExceptionInfo(params: Dap.ExceptionInfoParams): Promise<Dap.ExceptionInfoResult | Dap.Error> {
    const thread = this.threadManager.thread(params.threadId);
    if (!thread)
      return this._threadNotAvailableError();
    const details = thread.pausedDetails();
    const exception = details && details.exception;
    if (!exception)
      return errors.createSilentError(localize('error.threadNotPausedOnException', 'Thread is not paused on exception'));
    const preview = objectPreview.previewException(exception);
    return {
      exceptionId: preview.title,
      breakMode: this.threadManager.pauseOnExceptionsState() === 'all' ? 'always' : 'unhandled',
      details: {
        stackTrace: preview.stackTrace,
        evaluateName: undefined  // This is not used by vscode.
      }
    };
  }

  async _onSetVariable(params: Dap.SetVariableParams): Promise<Dap.SetVariableResult | Dap.Error> {
    let variableStore = this._findVariableStore(params.variablesReference);
    if (!variableStore)
      return errors.createSilentError(localize('error.variableNotFound', 'Variable not found'));

    params.value = this._wrapObjectLiteral(params.value.trim());
    return variableStore.setVariable(params);
  }

  setCurrentExecutionContext(item: ExecutionContextTree | undefined) {
    this._currentExecutionContext = item;
  }

  async revealLocation(location: Location, revealConfirmed: Promise<void>) {
    if (this._locationToReveal)
      return;
    this._locationToReveal = location;
    this._dap.thread({ reason: 'started', threadId: threadForSourceRevealId });
    this._dap.stopped({
      reason: 'goto',
      threadId: threadForSourceRevealId,
      allThreadsStopped: false,
    });

    await revealConfirmed;

    this._dap.continued({ threadId: threadForSourceRevealId, allThreadsContinued: false });
    this._dap.thread({ reason: 'exited', threadId: threadForSourceRevealId });
    this._locationToReveal = undefined;
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

  _wrapObjectLiteral(code: string): string {
    // Only parenthesize what appears to be an object literal.
    if (!(/^\s*\{/.test(code) && /\}\s*$/.test(code)))
      return code;

    const parse = (async () => 0).constructor;
    try {
      // Check if the code can be interpreted as an expression.
      parse('return ' + code + ';');

      // No syntax error! Does it work parenthesized?
      const wrappedCode = '(' + code + ')';
      parse(wrappedCode);

      return wrappedCode;
    } catch (e) {
      return code;
    }
  }

  rewriteTopLevelAwait(code: string): string | undefined {
    code = '(async () => {' + code + '\n})()';
    let body: ts.Block;
    try {
      const sourceFile = ts.createSourceFile(
        'file.js',
        code,
        ts.ScriptTarget.ESNext,
        /*setParentNodes */ true);
      body = sourceFile.statements[0]['expression']['expression']['expression']['body'] as ts.Block;
    } catch(e) {
      return;
    }

    const changes: {start: number, end: number, text: string}[] = [];
    let containsAwait = false;
    let containsReturn = false;

    function traverse(node: ts.Node) {
      switch (node.kind) {
        case ts.SyntaxKind.ClassDeclaration:
          const cd = node as ts.ClassDeclaration;
          if (cd.parent === body && cd.name)
            changes.push({text: cd.name.text + '=', start: cd.pos, end: cd.pos});
          break;
        case ts.SyntaxKind.FunctionDeclaration:
          const fd = node as ts.FunctionDeclaration;
          if (fd.name)
            changes.push({text: fd.name.text + '=', start: fd.pos, end: fd.pos});
          return;
        case ts.SyntaxKind.FunctionExpression:
        case ts.SyntaxKind.ArrowFunction:
        case ts.SyntaxKind.MethodDeclaration:
          return;
        case ts.SyntaxKind.AwaitExpression:
          containsAwait = true;
          break;
        case ts.SyntaxKind.ForOfStatement:
          if ((node as ts.ForOfStatement).awaitModifier)
            containsAwait = true;
          break;
        case ts.SyntaxKind.ReturnStatement:
          containsReturn = true;
          break;
        case ts.SyntaxKind.VariableDeclarationList:
          const vd = node as ts.VariableDeclarationList;

          let s = code.substr(vd.pos);
          let skip = 0;
          while (skip < s.length && /^\s$/.test(s[skip]))
            ++skip;
          s = s.substring(skip);
          const dec = (s.startsWith('const')) ? 'const' : s.substr(0, 3);
          let vdpos = vd.pos + skip;

          if (vd.parent.kind === ts.SyntaxKind.ForOfStatement)
            break;
          if (!vd.declarations.length)
            break;
          if (dec !== 'var') {
            if (vd.parent.kind !== ts.SyntaxKind.VariableStatement || vd.parent.parent !== body)
              break;
          }
          const onlyOneDeclaration = vd.declarations.length === 1;
          changes.push({text: onlyOneDeclaration ? 'void' : 'void (', start: vdpos, end: vdpos + dec.length});
          for (const declaration of vd.declarations) {
            if (!declaration.initializer) {
              changes.push({text: '(', start: declaration.pos, end: declaration.pos});
              changes.push({text: '=undefined)', start: declaration.end, end: declaration.end});
              continue;
            }
            changes.push({text: '(', start: declaration.pos, end: declaration.pos});
            changes.push({text: ')', start: declaration.end, end: declaration.end});
          }
          if (!onlyOneDeclaration) {
            const last = vd.declarations[vd.declarations.length - 1];
            changes.push({text: ')', start: last.end, end: last.end});
          }
          break;
      }
      ts.forEachChild(node, traverse);
    }
    traverse(body);

    // Top-level return is not allowed.
    if (!containsAwait || containsReturn)
      return;

    const last = body.statements[body.statements.length - 1];
    if (last.kind === ts.SyntaxKind.ExpressionStatement) {
      changes.push({text: 'return (', start: last.pos, end: last.pos});
      if (code[last.end - 1] !== ';')
        changes.push({text: ')', start: last.end, end: last.end});
      else
        changes.push({text: ')', start: last.end - 1, end: last.end - 1});
    }
    while (changes.length) {
      const change = changes.pop()!;
      code = code.substr(0, change.start) + change.text + code.substr(change.end);
    }
    return code;
  }
}