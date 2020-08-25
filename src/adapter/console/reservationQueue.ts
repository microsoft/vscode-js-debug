/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IDisposable } from '../../common/disposable';
import { EventEmitter } from '../../common/events';

/**
 * A queue that allows inserting items that are built asynchronously, while
 * preserving insertion order.
 */
export class ReservationQueue<T> implements IDisposable {
  private q: Reservation<T>[] = [];
  private disposed = false;
  private onDrainedEmitter = new EventEmitter<void>();

  /**
   * Fires when the queue is drained.
   */
  public readonly onDrained = this.onDrainedEmitter.event;

  /**
   * Gets the current length of the queue.
   */
  public get length() {
    return this.q.length;
  }

  constructor(private readonly sink: (items: T[]) => void) {}

  /**
   * Enqueues an item or a promise for an item in the queue.
   */
  public enqueue(value: T | Promise<T>) {
    if (this.disposed) {
      return;
    }

    this.q.push(new Reservation(value));
    if (this.q.length === 1) {
      this.process();
    }
  }

  /**
   * Cancels processing of all pending items.
   * @inheritdoc
   */
  public dispose() {
    this.disposed = true;
    this.q = [];
  }

  private async process(): Promise<void> {
    const toIndex = this.q.findIndex(r => r.value === unsettled);
    if (toIndex === 0) {
      await this.q[0].wait;
    } else if (toIndex === -1) {
      this.sink(extractResolved(this.q));
      this.q = [];
    } else {
      this.sink(extractResolved(this.q.slice(0, toIndex)));
      this.q = this.q.slice(toIndex);
    }

    if (this.q.length) {
      this.process();
    } else {
      this.onDrainedEmitter.fire();
    }
  }
}

const extractResolved = <T>(list: ReadonlyArray<Reservation<T>>) =>
  list.map(i => i.value).filter((v): v is T => v !== rejected);

const unsettled = Symbol('unsettled');
const rejected = Symbol('unsettled');

/**
 * Item in the queue.
 */
class Reservation<T> {
  /**
   * Promise that is resolved when `value` is rejected or resolved.
   */
  public wait?: Promise<void>;

  /**
   * Current value, or an indication that the promise is pending or rejected.
   */
  public value: typeof unsettled | typeof rejected | T = unsettled;

  constructor(rawValue: T | Promise<T>) {
    if (!(rawValue instanceof Promise)) {
      this.value = rawValue;
      this.wait = Promise.resolve();
    } else {
      this.wait = rawValue.then(
        r => {
          this.value = r;
        },
        () => {
          this.value = rejected;
        },
      );
    }
  }
}
