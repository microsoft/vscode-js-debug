/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { ContextKey, IContextKeyTypes } from '../common/contributionUtils';

export class ManagedContextKey<T extends ContextKey> {
  private _value: IContextKeyTypes[T] | undefined;

  public set value(value: IContextKeyTypes[T] | undefined) {
    if (value !== this._value) {
      this._value = value;
      vscode.commands.executeCommand('setContext', this.key, value);
    }
  }

  public get value() {
    return this._value;
  }

  constructor(private readonly key: T) {}
}
