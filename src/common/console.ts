// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';

/**
 * Send to debug console.
 */
export function writeToConsole(message: string) {
  vscode.debug.activeDebugConsole.appendLine(message);
}
