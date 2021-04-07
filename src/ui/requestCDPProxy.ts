/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { Commands, registerCommand } from '../common/contributionUtils';
import { DebugSessionTracker } from './debugSessionTracker';

export const registerRequestCDPProxy = (
  context: vscode.ExtensionContext,
  tracker: DebugSessionTracker,
) => {
  context.subscriptions.push(
    registerCommand(vscode.commands, Commands.RequestCDPProxy, async sessionId => {
      const session = tracker.getById(sessionId);
      return await session?.customRequest('requestCDPProxy');
    }),
  );
};
