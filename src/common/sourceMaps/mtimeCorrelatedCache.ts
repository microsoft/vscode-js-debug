/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { debounce } from '../objUtils';
import { IDisposable } from '../disposable';
import { readfile, writeFile } from '../fsUtils';

export class CorrelatedCache<C, V> implements IDisposable {
  private cacheData?: Promise<{ [key: string]: { correlation: C; value: V } }>;

  /**
   * Scheules the cache to flush to disk.
   */
  public readonly flush = debounce(this.debounceTime, () => this.flushImmediately());

  constructor(private readonly storageFile: string, private readonly debounceTime = 500) {
    try {
      mkdirSync(dirname(storageFile));
    } catch {
      // ignored
    }
  }

  /**
   * Gets the value from the map if it exists and the correlation matches.
   */
  public async lookup(key: string, correlation: C): Promise<V | undefined> {
    const data = await this.getData();
    const entry = data[key];
    return entry && entry.correlation === correlation ? entry.value : undefined;
  }

  /**
   * Stores the value in the cache.
   */
  public async store(key: string, correlation: C, value: V) {
    const data = await this.getData();
    data[key] = { correlation, value };
    this.flush();
  }

  /**
   * Flushes the cache to disk immediately.
   */
  public async flushImmediately() {
    this.flush.clear();
    return writeFile(this.storageFile, JSON.stringify(await this.getData()));
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    this.flushImmediately();
  }

  private getData() {
    if (!this.cacheData) {
      this.cacheData = this.hydrateFromDisk();
    }

    return this.cacheData;
  }

  private async hydrateFromDisk() {
    try {
      return JSON.parse(await readfile(this.storageFile)) || {};
    } catch (e) {
      return {};
    }
  }
}
