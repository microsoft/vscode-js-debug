/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { once } from './objUtils';

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

  public get size() {
    return this._listeners.size;
  }

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

/**
 * Map of listeners that deals with refcounting.
 */
export class ListenerMap<K, V> {
  private readonly map = new Map<K, EventEmitter<V>>();
  public readonly listeners: ReadonlyMap<K, EventEmitter<V>> = this.map;

  /**
   * Adds a listener for the givne event.
   */
  public listen(key: K, handler: (arg: V) => void): IDisposable {
    let emitter = this.map.get(key);
    if (!emitter) {
      emitter = new EventEmitter<V>();
      this.map.set(key, emitter);
    }

    const listener = emitter.event(handler);
    return {
      dispose: once(() => {
        listener.dispose();
        if (emitter?.size === 0) {
          this.map.delete(key);
        }
      }),
    };
  }

  /**
   * Emits the event for the listener.
   */
  public emit(event: K, value: V) {
    this.listeners.get(event)?.fire(value);
  }
}
