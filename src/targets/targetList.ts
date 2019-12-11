/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { EventEmitter } from '../common/events';

/**
 * A wrapper around map that fires an event emitter when it's mutated. Used
 * for manging lists of targets.
 */
export class ObservableMap<T> {
  private readonly changeEmitter = new EventEmitter<void>();
  private readonly targetMap = new Map<string, T>();

  /**
   * Event emitter that fires when the list of targets changes.
   */
  public readonly onChanged = this.changeEmitter.event;

  /**
   * Adds a new target to the list
   */
  public add(openerId: string, target: T) {
    this.targetMap.set(openerId, target);
    this.changeEmitter.fire();
  }

  /**
   * Gets a target by opener ID.
   */
  public get(openerId: string): T | undefined {
    return this.targetMap.get(openerId);
  }

  /**
   * Removes a target by opener ID.
   */
  public remove(openerId: string) {
    this.targetMap.delete(openerId);
    this.changeEmitter.fire();
  }

  /**
   * Returns a list of known targets.
   */
  public value() {
    return Array.from(this.targetMap.values());
  }
}
