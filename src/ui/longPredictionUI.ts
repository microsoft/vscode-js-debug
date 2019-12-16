/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import { Contributions } from '../common/contributionUtils';
import { join } from 'path';

const localize = nls.loadMessageBundle();

async function promptLongBreakpoint(workspaceFolder?: vscode.WorkspaceFolder) {
  const extConfig = vscode.workspace.getConfiguration(Contributions.ConfigSection);
  const shouldWarn = extConfig.get<boolean>(Contributions.WarnOnLongPredictionConfig);
  if (shouldWarn === false) {
    return;
  }

  const message = localize(
    'longPredictionWarning.message',
    "It's taking a while to configure your breakpoints. You can speed this up by updating the 'outFiles' in your launch.json.",
  );
  const openLaunch = localize('longPredictionWarning.open', 'Open launch.json');
  const dontShow = localize('longPredictionWarning.disable', "Don't show again");
  const result = await vscode.window.showWarningMessage(message, dontShow, openLaunch);

  if (result === dontShow) {
    await extConfig.update(Contributions.WarnOnLongPredictionConfig, false);
    return;
  }

  if (result !== openLaunch) {
    return;
  }

  if (!workspaceFolder) {
    workspaceFolder = await vscode.window.showWorkspaceFolderPick();
  }

  if (!workspaceFolder) {
    await vscode.window.showWarningMessage(
      localize('longPredictionWarning.noFolder', 'No workspace folder open.'),
    );
    return;
  }

  const doc = await vscode.workspace.openTextDocument(
    join(workspaceFolder.uri.fsPath, '.vscode', 'launch.json'),
  );
  await vscode.window.showTextDocument(doc);
}

export function registerLongBreakpointUI(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.debug.onDidReceiveDebugSessionCustomEvent(event =>
      promptLongBreakpoint(event.session.workspaceFolder),
    ),
  );
}
