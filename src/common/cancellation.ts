/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { CancellationToken } from 'vscode';
import { EventEmitter, IEvent } from './events';
import { IDisposable } from './disposable';
import { getDeferred } from './promiseUtil';

/**
 * Thrown from `cancellableRace` if cancellation is requested.
 */
export class TaskCancelledError extends Error {}

/**
 * Returns the result of the promise if it resolves before the cancellation
 * is requested. Otherwise, throws a TaskCancelledError.
 */
export function timeoutPromise<T>(
  promise: Promise<T>,
  cancellation: CancellationToken,
  message?: string,
): Promise<T> {
  if (cancellation.isCancellationRequested) {
    return Promise.reject(new TaskCancelledError(message || 'Task cancelled'));
  }

  const didTimeout = getDeferred<void>();
  const disposable = cancellation.onCancellationRequested(didTimeout.resolve);

  return Promise.race([
    didTimeout.promise.then(() => {
      throw new TaskCancelledError(message || 'Task cancelled');
    }),
    promise.finally(() => disposable.dispose()),
  ]);
}

/**
 * Like Promise.race, but cancels other promises after the first returns.
 */
export function cancellableRace<T>(
  promises: ReadonlyArray<(ct: CancellationToken) => Promise<T>>,
  parent?: CancellationToken,
): Promise<T> {
  const cts = new CancellationTokenSource(parent);

  const todo = promises.map(async fn => {
    try {
      return await fn(cts.token);
    } finally {
      cts.cancel();
    }
  });

  return Promise.race(todo);
}

const shortcutEvent = Object.freeze(function (callback, context?): IDisposable {
  const handle = setTimeout(callback.bind(context), 0);
  return {
    dispose() {
      clearTimeout(handle);
    },
  };
} as IEvent<void>);

export const NeverCancelled: CancellationToken = Object.freeze({
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
});

export const Cancelled: CancellationToken = Object.freeze({
  isCancellationRequested: true,
  onCancellationRequested: shortcutEvent,
});

/**
 * A cancellation source creates and controls a [cancellation token](#CancellationToken).
 * Mirrored here because the debugger internals can't depend on concrete types
 * from `vscode`.
 */
export class CancellationTokenSource {
  private _token?: CancellationToken = undefined;
  private _parentListener?: IDisposable = undefined;

  constructor(parent?: CancellationToken) {
    this._parentListener = parent && parent.onCancellationRequested(this.cancel, this);
  }

  /**
   * Returns a cancellation token source that times out after the given duration.
   */
  public static withTimeout(timeout: number, parent?: CancellationToken) {
    const cts = new CancellationTokenSource(parent);
    const token = (cts._token = new MutableToken());

    const timer = setTimeout(() => token.cancel(), timeout);
    token.onCancellationRequested(() => clearTimeout(timer));

    return cts;
  }

  get token(): CancellationToken {
    if (!this._token) {
      // be lazy and create the token only when
      // actually needed
      this._token = new MutableToken();
    }
    return this._token;
  }

  cancel(): void {
    if (!this._token) {
      // save an object by returning the default
      // cancelled token when cancellation happens
      // before someone asks for the token
      this._token = Cancelled;
    } else if (this._token instanceof MutableToken) {
      // actually cancel
      this._token.cancel();
    }
  }

  dispose(cancel = false): void {
    if (cancel) {
      this.cancel();
    }
    if (this._parentListener) {
      this._parentListener.dispose();
    }
    if (!this._token) {
      // ensure to initialize with an empty token if we had none
      this._token = NeverCancelled;
    } else if (this._token instanceof MutableToken) {
      // actually dispose
      this._token.dispose();
    }
  }
}

class MutableToken implements CancellationToken {
  private _isCancelled = false;
  private _emitter: EventEmitter<void> | null = null;

  public cancel() {
    if (!this._isCancelled) {
      this._isCancelled = true;
      if (this._emitter) {
        this._emitter.fire(undefined);
        this.dispose();
      }
    }
  }

  get isCancellationRequested(): boolean {
    return this._isCancelled;
  }

  get onCancellationRequested(): IEvent<void> {
    if (this._isCancelled) {
      return shortcutEvent;
    }
    if (!this._emitter) {
      this._emitter = new EventEmitter<void>();
    }
    return this._emitter.event;
  }

  public dispose(): void {
    if (this._emitter) {
      this._emitter.dispose();
      this._emitter = null;
    }
  }
}
