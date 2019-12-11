// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export interface Disposable {
  dispose(): void;
}

export interface Event<T> {
  (listener: (e: T) => any, thisArgs?: any, disposables?: Disposable[]): Disposable;
}

type ListenerData<T> = {
  listener: (e: T) => void;
  thisArg: any;
};

export class EventEmitter<T> implements Disposable {
  public event: Event<T>;

  private _deliveryQueue?: { data: ListenerData<T>; event: T }[];
  private _listeners = new Set<ListenerData<T>>();

  constructor() {
    this.event = (listener: (e: T) => any, thisArg?: any, disposables?: Disposable[]) => {
      const data: ListenerData<T> = { listener, thisArg };
      this._listeners.add(data);
      const result = {
        dispose: () => {
          result.dispose = () => {};
          this._listeners.delete(data);
        },
      };
      if (disposables) disposables.push(result);
      return result;
    };
  }

  fire(event: T): void {
    let dispatch = !this._deliveryQueue;
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
