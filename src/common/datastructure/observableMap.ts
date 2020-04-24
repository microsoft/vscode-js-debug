/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { EventEmitter } from '../events';

/**
 * A wrapper around map that fires an event emitter when it's mutated. Used
 * for manging lists of targets.
 */
export class ObservableMap<K, V> {
  private readonly changeEmitter = new EventEmitter<void>();
  private readonly addEmitter = new EventEmitter<[K, V]>();
  private readonly removeEmitter = new EventEmitter<[K, V]>();
  private readonly targetMap = new Map<K, V>();

  /**
   * Event emitter that fires when the list of targets changes.
   */
  public readonly onChanged = this.changeEmitter.event;

  /**
   * Event emitter that fires when the list of targets is added to.
   */
  public readonly onAdd = this.addEmitter.event;

  /**
   * Event emitter that fires when the list of targets is removed from.
   */
  public readonly onRemove = this.removeEmitter.event;

  /**
   * Gets the number of elements in the map.
   */
  public get size() {
    return this.targetMap.size;
  }

  /**
   * Adds a new target to the list
   */
  public add(key: K, target: V) {
    this.targetMap.set(key, target);
    this.addEmitter.fire([key, target]);
    this.changeEmitter.fire();
  }

  /**
   * Gets a target by opener ID.
   */
  public get(key: K): V | undefined {
    return this.targetMap.get(key);
  }

  /**
   * Removes a target by opener ID.
   * @returns true if a value was removed
   */
  public remove(key: K): boolean {
    const previous = this.targetMap.get(key);
    if (previous === undefined) {
      return false;
    }

    this.targetMap.delete(key);
    this.removeEmitter.fire([key, previous]);
    this.changeEmitter.fire();
    return true;
  }

  /**
   * Returns a list of known targets.
   */
  public value() {
    return this.targetMap.values();
  }
}
