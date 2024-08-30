/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import type * as vscode from 'vscode';

/**
 * Terminal link provider available when running in the vscode UI.
 */
export interface ITerminalLinkProvider<T extends vscode.TerminalLink = vscode.TerminalLink>
  extends vscode.TerminalLinkProvider<T>
{
  /**
   * Turns on link handling in the given terminal.
   */
  enableHandlingInTerminal(terminal: vscode.Terminal): void;
}

export const ITerminalLinkProvider = Symbol('ITerminalLinkProvider');
