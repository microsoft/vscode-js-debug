/**
 * Returns a promise that resolves after the given time.
 */
export const delay = (duration: number) => new Promise<void>(resolve => setTimeout(resolve, duration));

export interface IDeferred<T> {
  resolve: (result: T) => void;
  reject: (err: Error) => void;
  promise: Promise<T>;
}

export function getDeferred<T>(): IDeferred<T> {
  let resolve: IDeferred<T>['resolve'] = null!;
  let reject: IDeferred<T>['reject'] = null!;

  // Promise constructor is called synchronously
  const promise = new Promise<T>((_resolve, _reject) => {
      resolve = _resolve;
      reject = _reject;
  });

  return { resolve, reject, promise };
}
