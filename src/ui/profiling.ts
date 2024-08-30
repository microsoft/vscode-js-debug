/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Container } from 'inversify';
import * as vscode from 'vscode';
import { Commands, registerCommand } from '../common/contributionUtils';
import { UiProfileManager } from './profiling/uiProfileManager';

export const registerProfilingCommand = (
  context: vscode.ExtensionContext,
  container: Container,
) => {
  const manager = container.get(UiProfileManager);

  context.subscriptions.push(
    registerCommand(vscode.commands, Commands.StartProfile, sessionIdOrArgs =>
      manager.start(
        typeof sessionIdOrArgs === 'string'
          ? { sessionId: sessionIdOrArgs }
          : sessionIdOrArgs ?? {},
      )),
    registerCommand(vscode.commands, Commands.StopProfile, sessionId => manager.stop(sessionId)),
  );
};
