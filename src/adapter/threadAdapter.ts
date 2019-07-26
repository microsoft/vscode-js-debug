/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

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

const localize = nls.loadMessageBundle();

type EvaluatePrep = {
  variableStore: VariableStore;
  stackFrame?: StackFrame;
};

export class ThreadAdapter {
  private _dap: Dap.Api;
  private _thread: Thread | undefined;
  private _executionContextId: number | undefined;

  constructor(dap: Dap.Api) {
    this._dap = dap;
    this._dap.on('continue', params => this._onContinue(params));
    this._dap.on('pause', params => this._onPause(params));
    this._dap.on('next', params => this._onNext(params));
    this._dap.on('stepIn', params => this._onStepIn(params));
    this._dap.on('stepOut', params => this._onStepOut(params));
    this._dap.on('restartFrame', params => this._onRestartFrame(params));
    this._dap.on('scopes', params => this._onScopes(params));
    this._dap.on('variables', params => this._onVariables(params));
    this._dap.on('evaluate', params => this._onEvaluate(params));
    this._dap.on('completions', params => this._onCompletions(params));
    this._dap.on('exceptionInfo', params => this._onExceptionInfo(params));
    this._dap.on('setVariable', params => this._onSetVariable(params));
  }

  thread(): Thread | undefined {
    return this._thread;
  }

  _threadNotAvailableError(): Dap.Error {
    return errors.createSilentError(localize('error.threadNotFound', 'Thread not found'));
  }

  async _onContinue(_: Dap.ContinueParams): Promise<Dap.ContinueResult | Dap.Error> {
    if (!this._thread)
      return this._threadNotAvailableError();
    if (!await this._thread.resume())
      return errors.createSilentError(localize('error.resumeDidFail', 'Unable to resume'));
    return { allThreadsContinued: false };
  }

  async _onPause(_: Dap.PauseParams): Promise<Dap.PauseResult | Dap.Error> {
    if (!this._thread)
      return this._threadNotAvailableError();
    if (!await this._thread.pause())
      return errors.createSilentError(localize('error.pauseDidFail', 'Unable to pause'));
    return {};
  }

  async _onNext(_: Dap.NextParams): Promise<Dap.NextResult | Dap.Error> {
    if (!this._thread)
      return this._threadNotAvailableError();
    if (!await this._thread.stepOver())
      return errors.createSilentError(localize('error.stepOverDidFail', 'Unable to step next'));
    return {};
  }

  async _onStepIn(_: Dap.StepInParams): Promise<Dap.StepInResult | Dap.Error> {
    if (!this._thread)
      return this._threadNotAvailableError();
    if (!await this._thread.stepInto())
      return errors.createSilentError(localize('error.stepInDidFail', 'Unable to step in'));
    return {};
  }

  async _onStepOut(_: Dap.StepOutParams): Promise<Dap.StepOutResult | Dap.Error> {
    if (!this._thread)
      return this._threadNotAvailableError();
    if (!await this._thread.stepOut())
      return errors.createSilentError(localize('error.stepOutDidFail', 'Unable to step out'));
    return {};
  }

  async _onRestartFrame(params: Dap.RestartFrameParams): Promise<Dap.RestartFrameResult | Dap.Error> {
    if (!this._thread)
      return this._threadNotAvailableError();
    const stackFrame = this._findStackFrame(params.frameId);
    if (!stackFrame)
      return errors.createSilentError(localize('error.stackFrameNotFound', 'Stack frame not found'));
    if (!this._thread.restartFrame(stackFrame))
      return errors.createUserError(localize('error.restartFrameAsync', 'Cannot restart asynchronous frame'));
    return {};
  }

  async onStackTrace(params: Dap.StackTraceParams): Promise<Dap.StackTraceResult | Dap.Error> {
    if (!this._thread)
      return this._threadNotAvailableError();
    const details = this._thread.pausedDetails();
    if (!details)
      return errors.createSilentError(localize('error.threadNotPaused', 'Thread is not paused'));
    return details.stackTrace.toDap(params);
  }

  _findStackFrame(frameId: number): StackFrame | undefined {
    if (!this._thread)
      return undefined;
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
    if (!this._thread)
      return undefined;
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

  _prepareForEvaluate(frameId?: number): { result?: EvaluatePrep, error?: Dap.Error } {
    if (!this._thread)
      return { error: this._threadNotAvailableError() };

    let stackFrame: StackFrame | undefined;
    if (frameId !== undefined) {
      const stackFrame = this._findStackFrame(frameId);
      if (!stackFrame)
        return { error: errors.createSilentError(localize('error.stackFrameNotFound', 'Stack frame not found')) };
      if (!stackFrame.callFrameId())
        return { error: errors.createSilentError(localize('error.evaluateOnAsyncStackFrame', 'Unable to evaluate on async stack frame')) };
    }
    return {
      result: {
        stackFrame,
        variableStore: stackFrame ? this._thread.pausedVariables()! : this._thread.replVariables
      }
    };
  }

  async _onEvaluate(args: Dap.EvaluateParams): Promise<Dap.EvaluateResult | Dap.Error> {
    if (!this._thread)
      return this._threadNotAvailableError();

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
        const rewritten = sourceUtils.rewriteTopLevelAwait(params.expression);
        if (rewritten) {
          params.expression = rewritten;
          params.awaitPromise = true;
        }
      }
    }

    const response = prep.stackFrame
      ? await this._thread.cdp().Debugger.evaluateOnCallFrame({ ...params, callFrameId: prep.stackFrame.callFrameId()! })
      : await this._thread.cdp().Runtime.evaluate({ ...params, contextId: this._executionContextId });
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

    return { result: '', variablesReference: 0 };
  }

  async _onCompletions(params: Dap.CompletionsParams): Promise<Dap.CompletionsResult | Dap.Error> {
    if (!this._thread)
      return this._threadNotAvailableError();
    const { result: maybePrep, error } = this._prepareForEvaluate(params.frameId);
    if (error)
      return error;
    const prep = maybePrep as EvaluatePrep;
    const line = params.line === undefined ? 0 : params.line - 1;
    return { targets: await completions.completions(this._thread.cdp(), this._executionContextId, prep.stackFrame, params.text, line, params.column) };
  }

  async _onExceptionInfo(_: Dap.ExceptionInfoParams): Promise<Dap.ExceptionInfoResult | Dap.Error> {
    if (!this._thread)
      return this._threadNotAvailableError();
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

  setExecutionContext(thread: Thread | undefined, executionContextId: number | undefined) {
    this._executionContextId = executionContextId;
    this._thread = thread;
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
