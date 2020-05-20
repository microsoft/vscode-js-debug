/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { DebugSessionTracker } from './debugSessionTracker';
import { registerCommand, Commands } from '../common/contributionUtils';

export const registerRevealPage = (
  context: vscode.ExtensionContext,
  tracker: DebugSessionTracker,
) => {
  context.subscriptions.push(
    registerCommand(vscode.commands, Commands.RevealPage, async sessionId => {
      const session = tracker.sessions.get(sessionId);
      await session?.customRequest('revealPage');
    }),
  );
};
