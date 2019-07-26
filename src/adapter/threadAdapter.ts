// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as nls from 'vscode-nls';
import Cdp from '../cdp/api';
import Dap from '../dap/api';
import * as sourceUtils from '../utils/sourceUtils';
import * as completions from './completions';
import * as errors from './errors';
import * as objectPreview from './objectPreview';
import { StackFrame } from './stackTrace';
import { Thread } from './threads';
import { VariableStore } from './variables';
import { Disposable } from 'vscode';

const localize = nls.loadMessageBundle();

export class DummyThreadAdapter {
  private _unsubscribe: (() => void)[];

  constructor(dap: Dap.Api) {
    const methods = ['continue', 'pause', 'next', 'stepIn', 'stepOut', 'restartFrame', 'scopes', 'variables', 'evaluate', 'completions', 'exceptionInfo', 'setVariable'];
    this._unsubscribe = methods.map(method => dap.on(method as any, _ => Promise.resolve(this._threadNotAvailableError())));
  }

  async onStackTrace(params: Dap.StackTraceParams): Promise<Dap.StackTraceResult | Dap.Error> {
    return this._threadNotAvailableError();
  }

  _threadNotAvailableError(): Dap.Error {
    return errors.createSilentError(localize('error.threadNotFound', 'Thread not found'));
  }

  dispose() {
    for (const unsubscribe of this._unsubscribe)
      unsubscribe();
    this._unsubscribe = [];
  }
}

export class ThreadAdapter implements Disposable {
  private _unsubscribe: (() => void)[];
  private _thread: Thread;
  private _executionContextId: number | undefined;

  constructor(dap: Dap.Api, thread: Thread | undefined, executionContextId: number | undefined) {
    this._thread = thread!;
    this._executionContextId = executionContextId;
    this._unsubscribe = [
      dap.on('continue', params => this._onContinue(params)),
      dap.on('pause', params => this._onPause(params)),
      dap.on('next', params => this._onNext(params)),
      dap.on('stepIn', params => this._onStepIn(params)),
      dap.on('stepOut', params => this._onStepOut(params)),
      dap.on('restartFrame', params => this._onRestartFrame(params)),
      dap.on('scopes', params => this._onScopes(params)),
      dap.on('variables', params => this._onVariables(params)),
      dap.on('evaluate', params => this._onEvaluate(params)),
      dap.on('completions', params => this._onCompletions(params)),
      dap.on('exceptionInfo', params => this._onExceptionInfo(params)),
      dap.on('setVariable', params => this._onSetVariable(params)),
    ];
  }

  dispose() {
    for (const unsubscribe of this._unsubscribe)
      unsubscribe();
    this._unsubscribe = [];
  }

  _stackFrameNotFoundError(): Dap.Error {
    return errors.createSilentError(localize('error.stackFrameNotFound', 'Stack frame not found'));
  }

  _evaluateOnAsyncFrameError(): Dap.Error {
    return errors.createSilentError(localize('error.evaluateOnAsyncStackFrame', 'Unable to evaluate on async stack frame'));
  }

  async _onContinue(_: Dap.ContinueParams): Promise<Dap.ContinueResult | Dap.Error> {
    if (!await this._thread.resume())
      return errors.createSilentError(localize('error.resumeDidFail', 'Unable to resume'));
    return { allThreadsContinued: false };
  }

  async _onPause(_: Dap.PauseParams): Promise<Dap.PauseResult | Dap.Error> {
    if (!await this._thread.pause())
      return errors.createSilentError(localize('error.pauseDidFail', 'Unable to pause'));
    return {};
  }

  async _onNext(_: Dap.NextParams): Promise<Dap.NextResult | Dap.Error> {
    if (!await this._thread.stepOver())
      return errors.createSilentError(localize('error.stepOverDidFail', 'Unable to step next'));
    return {};
  }

  async _onStepIn(_: Dap.StepInParams): Promise<Dap.StepInResult | Dap.Error> {
    if (!await this._thread.stepInto())
      return errors.createSilentError(localize('error.stepInDidFail', 'Unable to step in'));
    return {};
  }

  async _onStepOut(_: Dap.StepOutParams): Promise<Dap.StepOutResult | Dap.Error> {
    if (!await this._thread.stepOut())
      return errors.createSilentError(localize('error.stepOutDidFail', 'Unable to step out'));
    return {};
  }

  async _onRestartFrame(params: Dap.RestartFrameParams): Promise<Dap.RestartFrameResult | Dap.Error> {
    const stackFrame = this._findStackFrame(params.frameId);
    if (!stackFrame)
      return errors.createSilentError(localize('error.stackFrameNotFound', 'Stack frame not found'));
    if (!this._thread.restartFrame(stackFrame))
      return errors.createUserError(localize('error.restartFrameAsync', 'Cannot restart asynchronous frame'));
    return {};
  }

  async onStackTrace(params: Dap.StackTraceParams): Promise<Dap.StackTraceResult | Dap.Error> {
    const details = this._thread.pausedDetails();
    if (!details)
      return errors.createSilentError(localize('error.threadNotPaused', 'Thread is not paused'));
    return details.stackTrace.toDap(params);
  }

  _findStackFrame(frameId: number): StackFrame | undefined {
    const details = this._thread.pausedDetails();
    if (!details)
      return undefined;
    const stackFrame = details.stackTrace.frame(frameId);
    return stackFrame || undefined;
  }

  async _onScopes(params: Dap.ScopesParams): Promise<Dap.ScopesResult | Dap.Error> {
    const stackFrame = this._findStackFrame(params.frameId);
    if (!stackFrame)
      return errors.createSilentError(localize('error.stackFrameNotFound', 'Stack frame not found'));
    return stackFrame.scopes();
  }

  _findVariableStore(variablesReference: number): VariableStore | undefined {
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

  async _onEvaluate(args: Dap.EvaluateParams): Promise<Dap.EvaluateResult | Dap.Error> {
    let callFrameId: Cdp.Debugger.CallFrameId | undefined;
    if (args.frameId !== undefined) {
      const stackFrame = this._findStackFrame(args.frameId);
      if (!stackFrame)
        return this._stackFrameNotFoundError();
      callFrameId = stackFrame.callFrameId();
      if (!callFrameId)
        return this._evaluateOnAsyncFrameError();
    }

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
        const rewritten = sourceUtils.rewriteTopLevelAwait(params.expression);
        if (rewritten) {
          params.expression = rewritten;
          params.awaitPromise = true;
        }
      }
    }

    const responsePromise = callFrameId
      ? this._thread.cdp().Debugger.evaluateOnCallFrame({ ...params, callFrameId })
      : this._thread.cdp().Runtime.evaluate({ ...params, contextId: this._executionContextId });

    // Report result for repl immediately so that the user could see the expression they entered.
    if (args.context === 'repl') {
      this._evaluateAndOutput(responsePromise);
      return { result: '', variablesReference: 0 };
    }

    const response = await responsePromise;
    if (!response)
      return errors.createSilentError(localize('error.evaluateDidFail', 'Unable to evaluate'));

    const variableStore = callFrameId ? this._thread.pausedVariables()! : this._thread.replVariables;
    const variable = await variableStore.createVariable(response.result, args.context);
    return {
      type: response.result.type,
      result: variable.value,
      variablesReference: variable.variablesReference,
      namedVariables: variable.namedVariables,
      indexedVariables: variable.indexedVariables,
    };
  }

  async _evaluateAndOutput(responsePromise: Promise<Cdp.Runtime.EvaluateResult | undefined> | Promise<Cdp.Debugger.EvaluateOnCallFrameResult | undefined>) {
    const response = await responsePromise;
    if (!response)
      return;

    const outputSlot = this._thread.claimOutputSlot();
    if (response.exceptionDetails) {
      outputSlot(await this._thread.formatException(response.exceptionDetails, '↳ '));
    } else {
      const text = '\x1b[32m↳ ' + objectPreview.previewRemoteObject(response.result) + '\x1b[0m';
      const variablesReference = await this._thread.replVariables.createVariableForOutput(text, [response.result]);
      const output = {
        category: 'stdout',
        output: '',
        variablesReference,
      } as Dap.OutputEventParams;
      outputSlot(output);
    }
  }

  async _onCompletions(params: Dap.CompletionsParams): Promise<Dap.CompletionsResult | Dap.Error> {
    let stackFrame: StackFrame | undefined;
    if (params.frameId !== undefined) {
      stackFrame = this._findStackFrame(params.frameId);
      if (!stackFrame)
        return this._stackFrameNotFoundError();
      if (!stackFrame.callFrameId())
        return this._evaluateOnAsyncFrameError();
    }
    const line = params.line === undefined ? 0 : params.line - 1;
    return { targets: await completions.completions(this._thread.cdp(), this._executionContextId, stackFrame, params.text, line, params.column) };
  }

  async _onExceptionInfo(_: Dap.ExceptionInfoParams): Promise<Dap.ExceptionInfoResult | Dap.Error> {
    const details = this._thread.pausedDetails();
    const exception = details && details.exception;
    if (!exception)
      return errors.createSilentError(localize('error.threadNotPausedOnException', 'Thread is not paused on exception'));
    const preview = objectPreview.previewException(exception);
    return {
      exceptionId: preview.title,
      breakMode: 'all',
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

  _wrapObjectLiteral(code: string): string {
    // Only parenthesize what appears to be an object literal.
    if (!(/^\s*\{/.test(code) && /\}\s*$/.test(code)))
      return code;

    // Function constructor.
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
}
