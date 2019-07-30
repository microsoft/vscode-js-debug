// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as nls from 'vscode-nls';
import Dap from '../dap/api';
import * as errors from './errors';
import { Thread, ExecutionContext } from './threads';

const localize = nls.loadMessageBundle();

export class DummyThreadAdapter {
  private _unsubscribe: (() => void)[];

  constructor(dap: Dap.Api) {
    const methods = ['continue', 'pause', 'next', 'stepIn', 'stepOut', 'restartFrame', 'scopes', 'evaluate', 'completions', 'exceptionInfo'];
    this._unsubscribe = methods.map(method => dap.on(method as any, _ => Promise.resolve(this._threadNotAvailableError())));
  }

  async onStackTrace(_: Dap.StackTraceParams): Promise<Dap.StackTraceResult | Dap.Error> {
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

export class ThreadAdapter {
  private _unsubscribe: (() => void)[];
  private _thread: Thread;

  constructor(dap: Dap.Api, thread: Thread, context?: ExecutionContext) {
    this._thread = thread;
    const contextId = context ? context.description.id : undefined;
    this._unsubscribe = [
      dap.on('continue', _ => this._thread.resume()),
      dap.on('pause', _ => this._thread.pause()),
      dap.on('next', _ => this._thread.stepOver()),
      dap.on('stepIn', _ => this._thread.stepInto()),
      dap.on('stepOut', _ => this._thread.stepOut()),
      dap.on('restartFrame', params => this._thread.restartFrame(params)),
      dap.on('scopes', params => this._thread.scopes(params)),
      dap.on('evaluate', params => this._thread.evaluate(params, contextId)),
      dap.on('completions', params => this._thread.completions(params, contextId)),
      dap.on('exceptionInfo', _ => this._thread.exceptionInfo()),
    ];
  }

  dispose() {
    for (const unsubscribe of this._unsubscribe)
      unsubscribe();
    this._unsubscribe = [];
  }

  async onStackTrace(params: Dap.StackTraceParams): Promise<Dap.StackTraceResult | Dap.Error> {
    return this._thread.stackTrace(params);
  }
}
