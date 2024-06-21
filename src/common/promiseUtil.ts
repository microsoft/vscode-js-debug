/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IDisposable } from './disposable';

export const delay = (duration: number) =>
  isFinite(duration)
    ? new Promise<void>(resolve => setTimeout(resolve, duration))
    : new Promise<void>(() => undefined);

export const disposableTimeout = (fn: () => void, delay?: number): IDisposable => {
  const timeout = setTimeout(fn, delay);
  return { dispose: () => clearTimeout(timeout) };
};

export interface IDeferred<T> {
  resolve: (result: T) => void;
  reject: (err: Error) => void;
  hasSettled(): boolean;
  settledValue: T | undefined;
  promise: Promise<T>;
}

/**
 * Returns a promise that resolves as soon as any of the given promises
 * returns a truthy value.
 */
export function some<T>(
  promises: ReadonlyArray<Promise<T | undefined | null | false | ''>>,
): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    let remaining = promises.length;
    for (const prom of promises) {
      prom
        .then(p => {
          if (p) {
            resolve(p);
            remaining = -1;
          } else if (--remaining === 0) {
            resolve(undefined);
          }
        })
        .catch(reject);
    }
  });
}

export async function findIndexAsync<T>(
  array: ReadonlyArray<T>,
  predicate: (item: T) => Promise<unknown>,
): Promise<number> {
  for (let i = 0; i < array.length; i++) {
    if (await predicate(array[i])) {
      return i;
    }
  }

  return -1;
}

export function getDeferred<T>(): IDeferred<T> {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  let resolve: IDeferred<T>['resolve'] = null!;

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  let reject: IDeferred<T>['reject'] = null!;

  let settled = false;
  let settledValue: T | undefined;

  // Promise constructor is called synchronously
  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = (value: T) => {
      settled = true;
      settledValue = value;
      _resolve(value);
    };
    reject = (error: Error) => {
      settled = true;
      _reject(error);
    };
  });

  return {
    resolve,
    reject,
    promise,
    get settledValue() {
      return settledValue;
    },
    hasSettled: () => settled,
  };
}
