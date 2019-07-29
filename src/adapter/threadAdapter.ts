// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as nls from 'vscode-nls';
import Cdp from '../cdp/api';
import Dap from '../dap/api';
import * as errors from './errors';
import { Thread } from './threads';

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
  private _executionContextId: Cdp.Runtime.ExecutionContextId | undefined;

  constructor(dap: Dap.Api, thread: Thread | undefined, executionContextId: number | undefined) {
    this._thread = thread!;
    this._executionContextId = executionContextId;
    this._unsubscribe = [
      dap.on('continue', _ => this._thread.resume()),
      dap.on('pause', _ => this._thread.pause()),
      dap.on('next', _ => this._thread.stepOver()),
      dap.on('stepIn', _ => this._thread.stepInto()),
      dap.on('stepOut', _ => this._thread.stepOut()),
      dap.on('restartFrame', params => this._thread.restartFrame(params)),
      dap.on('scopes', params => this._thread.scopes(params)),
      dap.on('evaluate', params => this._thread.evaluate(params, this._executionContextId)),
      dap.on('completions', params => this._thread.completions(params, this._executionContextId)),
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
