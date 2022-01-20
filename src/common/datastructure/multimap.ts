/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * A map that indexes its contents using multiple values.
 */
export class MultiMap<T, K extends { [key: string]: unknown }> {
  private readonly keygenPairs: [keyof K, (v: T) => unknown][] = [];
  private readonly maps: { [K2 in keyof K]: Map<K[K2], T> };

  constructor(keygen: { [K2 in keyof K]: (v: T) => K[K2] }) {
    this.maps = {} as any;
    this.keygenPairs = Object.entries(keygen);
    for (const [key] of this.keygenPairs) {
      this.maps[key] = new Map();
    }
  }

  public add(value: T) {
    for (const [name, keyFn] of this.keygenPairs) {
      this.maps[name].set(keyFn(value) as any, value);
    }
  }

  public get<K2 extends keyof K>(keyName: K2, key: K[K2]) {
    return this.maps[keyName].get(key);
  }

  public has<K2 extends keyof K>(keyName: K2, key: K[K2]) {
    return this.maps[keyName].has(key);
  }

  public delete(value: T) {
    for (const [name, keyFn] of this.keygenPairs) {
      const key = keyFn(value) as any;
      if (value === this.maps[name].get(key)) {
        this.maps[name].delete(key);
      }
    }
  }

  public clear() {
    for (const [key] of this.keygenPairs) {
      this.maps[key].clear();
    }
  }

  public [Symbol.iterator]() {
    return this.maps[this.keygenPairs[0][0]].values();
  }
}
