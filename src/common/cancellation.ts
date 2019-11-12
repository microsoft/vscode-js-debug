/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { CancellationToken } from 'vscode';
import { EventEmitter, Event } from './events';
import { IDisposable } from './disposable';

/**
 * Thrown from `cancellableRace` if cancellation is requested.
 */
export class TaskCancelledError extends Error {}

/**
 * Returns the result of the promise if it resolves before the cancellation
 * is requested. Otherwise, throws a TaskCancelledError.
 */
export function cancellableRace<T>(
  promise: Promise<T>,
  cancellation: CancellationToken,
  message?: string,
): Promise<T> {
  if (cancellation.isCancellationRequested) {
    return Promise.reject(new TaskCancelledError(message || 'Task cancelled'));
  }

  let didTimeout: () => void;
  const cancellationPromise = new Promise<void>(resolve => (didTimeout = resolve));
  const disposable = cancellation.onCancellationRequested(didTimeout!);

  return Promise.race([
    cancellationPromise.then(() => {
      throw new TaskCancelledError(message || 'Task cancelled');
    }),
    promise.finally(() => disposable.dispose()),
  ]);
}

const shortcutEvent = Object.freeze(function(callback, context?): IDisposable {
  const handle = setTimeout(callback.bind(context), 0);
  return {
    dispose() {
      clearTimeout(handle);
    },
  };
} as Event<any>);

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

    let timer = setTimeout(() => token.cancel(), timeout);
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

  dispose(cancel: boolean = false): void {
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
  private _isCancelled: boolean = false;
  private _emitter: EventEmitter<any> | null = null;

  constructor() {}

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

  get onCancellationRequested(): Event<any> {
    if (this._isCancelled) {
      return shortcutEvent;
    }
    if (!this._emitter) {
      this._emitter = new EventEmitter<any>();
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
