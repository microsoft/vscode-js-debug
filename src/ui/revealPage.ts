/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { Commands, registerCommand } from '../common/contributionUtils';
import { DebugSessionTracker } from './debugSessionTracker';

export const registerRevealPage = (
  context: vscode.ExtensionContext,
  tracker: DebugSessionTracker,
) => {
  context.subscriptions.push(
    registerCommand(vscode.commands, Commands.RevealPage, async sessionId => {
      const session = tracker.getById(sessionId);
      await session?.customRequest('revealPage');
    }),
  );
};
