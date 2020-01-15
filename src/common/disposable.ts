/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

export interface IDisposable {
  dispose(): void;
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

  constructor(initialItems?: ReadonlyArray<IDisposable>) {
    if (initialItems) {
      this.items = initialItems.slice();
    }
  }

  /**
   * Adds new items to the disposable list.
   */
  public push(...newItems: ReadonlyArray<IDisposable>) {
    if (this.disposed) {
      newItems.forEach(d => d.dispose());
      return;
    }

    this.items.push(...newItems);
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    this.items.forEach(i => i.dispose());
    this.items = [];
    this.disposed = true;
  }
}
