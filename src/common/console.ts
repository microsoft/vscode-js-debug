/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Send to debug console.
 */
export function writeToConsole(message: string) {
  vscode.debug.activeDebugConsole.appendLine(message);
}
