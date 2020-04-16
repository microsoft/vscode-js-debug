/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { Container } from 'inversify';
import { registerCommand, Contributions } from '../common/contributionUtils';
import { UiProfileManager } from './profiling/uiProfileManager';

export const registerProfilingCommand = (
  context: vscode.ExtensionContext,
  container: Container,
) => {
  const manager = container.get(UiProfileManager);

  context.subscriptions.push(
    registerCommand(vscode.commands, Contributions.StartProfileCommand, sessionIdOrArgs =>
      manager.start(
        typeof sessionIdOrArgs === 'string'
          ? { sessionId: sessionIdOrArgs }
          : sessionIdOrArgs ?? {},
      ),
    ),
    registerCommand(vscode.commands, Contributions.StopProfileCommand, sessionId =>
      manager.stop(sessionId),
    ),
  );
};
