/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { once } from './objUtils';

export interface IDisposable {
  dispose(): void;
}

export interface IReference<T> extends IDisposable {
  value: T;
}

export class RefCounter<T extends IDisposable> {
  private disposed = false;
  private count = 0;

  constructor(public readonly value: T) {}

  public checkout(): IReference<T> {
    if (this.disposed) {
      throw new Error('Cannot checkout a disposed instance');
    }

    this.count++;

    return {
      value: this.value,
      dispose: once(() => {
        if (--this.count === 0) {
          this.dispose();
        }
      }),
    };
  }

  public dispose() {
    if (!this.disposed) {
      this.disposed = true;
      this.value.dispose();
    }
  }
}

/**
 * A dispoable that does nothing.
 */
export const noOpDisposable = { dispose: () => undefined };

/**
 * Wraps the list as an IDisposable that invokes each list item once a dispose
 * happens. Has an advantage over simple arrays in that, once disposed, any
 * new items added are immediately disposed, avoiding some leaks.
 */
export class DisposableList {
  private disposed = false;
  private items: IDisposable[] = [];

  public get isDisposed() {
    return this.disposed;
  }

  constructor(initialItems?: ReadonlyArray<IDisposable>) {
    if (initialItems) {
      this.items = initialItems.slice();
    }
  }

  /**
   * Adds a callback fires when the list is disposed of.
   */
  public callback(...disposals: ReadonlyArray<() => void>) {
    for (const dispose of disposals) {
      this.push({ dispose });
    }
  }

  /**
   * Adds new items to the disposable list.
   */
  public push<T extends IDisposable>(newItem: T): T;
  public push(...newItems: ReadonlyArray<IDisposable>): void;
  public push(...newItems: ReadonlyArray<IDisposable>): IDisposable {
    if (this.disposed) {
      newItems.forEach(d => d.dispose());
      return newItems[0];
    }

    this.items.push(...newItems);
    return newItems[0];
  }

  /**
   * Removes the item from the list and disposes it.
   */
  public disposeObject(d: IDisposable) {
    this.items = this.items.filter(i => i !== d);
    d.dispose();
  }

  /**
   * Clears all items without disposing them
   */
  public clear() {
    const r = Promise.all(this.items.map(i => i.dispose()));
    this.items = [];
    return r;
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    const r = Promise.all(this.items.map(i => i.dispose()));
    this.items = [];
    this.disposed = true;
    return r;
  }
}
