/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Memento } from 'vscode';

export class TestMemento implements Memento {
  private readonly data = new Map<string, any>();

  keys(): readonly string[] {
    return [...this.data.keys()];
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: any, defaultValue?: any): T | T | undefined {
    return this.data.has(key) ? this.data.get(key) : defaultValue;
  }

  update(key: string, value: any): Thenable<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }
}
