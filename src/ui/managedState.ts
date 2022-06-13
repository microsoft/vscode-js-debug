/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';

const Uninitialized = Symbol('Uninitialized');

export class ManagedState<T> {
  private _value: T | typeof Uninitialized = Uninitialized;

  public write(memento: vscode.Memento, value: T) {
    if (value !== this.read(memento)) {
      this._value = value;
      memento.update(this.key, value);
    }
  }

  public read(memento: vscode.Memento) {
    if (this._value === Uninitialized) {
      this._value = memento.get<T>(this.key) ?? this.defaultValue;
    }

    return this._value;
  }

  constructor(private readonly key: string, private readonly defaultValue: T) {}
}
