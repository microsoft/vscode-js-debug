/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as _ from 'lodash';

class KeyAndValue<K, V> {
  constructor(public readonly key: K, public readonly value: V) {}

  public toString(): string {
    return `${this.key}: ${this.value}`;
  }
}

/**
 * A map which uses a projection of the key to compare its elements (This is
 * equivalent to define a custom comparison criteria in other languages)
 */
export class MapUsingProjection<K, V, P = K> implements Map<K, V> {
  private readonly projectionToKeyAndvalue: Map<P, KeyAndValue<K, V>>;

  constructor(
    private readonly projection: (key: K) => P,
    readonly initialContents?: Map<K, V> | Iterable<[K, V]> | ReadonlyArray<[K, V]>,
  ) {
    const entries = Array.from(_.defaultTo(initialContents, [])).map<[P, KeyAndValue<K, V>]>(
      pair => {
        const projected = this.projection(pair[0]);
        return [projected, new KeyAndValue(pair[0], pair[1])];
      },
    );

    this.projectionToKeyAndvalue = new Map<P, KeyAndValue<K, V>>(entries);
  }

  public clear(): void {
    this.projectionToKeyAndvalue.clear();
  }

  public delete(key: K): boolean {
    const keyProjected = this.projection(key);
    return this.projectionToKeyAndvalue.delete(keyProjected);
  }

  public forEach(callbackfn: (value: V, key: K, map: Map<K, V>) => void, thisArg?: any): void {
    this.projectionToKeyAndvalue.forEach(keyAndValue => {
      callbackfn.call(thisArg, keyAndValue.value, keyAndValue.key, this);
    }, thisArg);
  }

  public get(key: K): V | undefined {
    const keyProjected = this.projection(key);
    const value = this.projectionToKeyAndvalue.get(keyProjected);
    return value ? value.value : undefined;
  }

  public has(key: K): boolean {
    return this.projectionToKeyAndvalue.has(this.projection(key));
  }

  public set(key: K, value: V): this {
    this.projectionToKeyAndvalue.set(this.projection(key), new KeyAndValue(key, value));
    return this;
  }

  public get size(): number {
    return this.projectionToKeyAndvalue.size;
  }

  public *entries(): IterableIterator<[K, V]> {
    for (const keyAndValue of this.projectionToKeyAndvalue.values()) {
      yield [keyAndValue.key, keyAndValue.value];
    }
  }

  public *keys(): IterableIterator<K> {
    for (const keyAndValue of this.projectionToKeyAndvalue.values()) {
      yield keyAndValue.key;
    }
  }

  public *values(): IterableIterator<V> {
    for (const keyAndValue of this.projectionToKeyAndvalue.values()) {
      yield keyAndValue.value;
    }
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries();
  }

  public get [Symbol.toStringTag](): 'Map' {
    return JSON.stringify(Array.from(this.entries())) as 'Map';
  }

  public toString(): string {
    return `MapUsingProjection<${JSON.stringify([...this.entries()])}>`;
  }
}
