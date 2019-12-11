/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

export interface IDisposable {
  dispose(): void;
}

export interface IEvent<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (listener: (e: T) => void, thisArg?: any, disposables?: IDisposable[]): IDisposable;
}

type ListenerData<T, A> = {
  listener: (this: A, e: T) => void;
  thisArg?: A;
};

export class EventEmitter<T> implements IDisposable {
  public event: IEvent<T>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _deliveryQueue?: { data: ListenerData<T, any>; event: T }[];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _listeners = new Set<ListenerData<T, any>>();

  constructor() {
    this.event = <ThisArg>(
      listener: (this: ThisArg, e: T) => void,
      thisArg?: ThisArg,
      disposables?: IDisposable[],
    ) => {
      const data: ListenerData<T, ThisArg> = { listener, thisArg };
      this._listeners.add(data);
      const result = {
        dispose: () => {
          result.dispose = () => {
            /* no-op */
          };
          this._listeners.delete(data);
        },
      };
      if (disposables) disposables.push(result);
      return result;
    };
  }

  fire(event: T): void {
    const dispatch = !this._deliveryQueue;
    if (!this._deliveryQueue) this._deliveryQueue = [];
    for (const data of this._listeners) this._deliveryQueue.push({ data, event });
    if (!dispatch) return;
    for (let index = 0; index < this._deliveryQueue.length; index++) {
      const { data, event } = this._deliveryQueue[index];
      data.listener.call(data.thisArg, event);
    }
    this._deliveryQueue = undefined;
  }

  dispose() {
    this._listeners.clear();
    if (this._deliveryQueue) this._deliveryQueue = [];
  }
}
