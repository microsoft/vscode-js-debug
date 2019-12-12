/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
export const delay = (duration: number) =>
  new Promise<void>(resolve => setTimeout(resolve, duration));

export interface IDeferred<T> {
  resolve: (result: T) => void;
  reject: (err: Error) => void;
  hasSettled(): boolean;
  promise: Promise<T>;
}

export function getDeferred<T>(): IDeferred<T> {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  let resolve: IDeferred<T>['resolve'] = null!;

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  let reject: IDeferred<T>['reject'] = null!;

  let settled = false;

  // Promise constructor is called synchronously
  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = (value: T) => {
      settled = true;
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
    hasSettled: () => settled,
  };
}
