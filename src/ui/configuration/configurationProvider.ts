/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';

export interface IDebugConfigurationProvider extends vscode.DebugConfigurationProvider {
  readonly type: string;
}

export const IDebugConfigurationProvider = Symbol('IDebugConfigurationProvider');
