/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import { Configuration, readConfig, writeConfig } from '../common/contributionUtils';
import { join } from 'path';

const localize = nls.loadMessageBundle();

async function promptLongBreakpoint(workspaceFolder?: vscode.WorkspaceFolder) {
  if (!readConfig(vscode.workspace, Configuration.WarnOnLongPrediction)) {
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
    await writeConfig(vscode.workspace, Configuration.WarnOnLongPrediction, false);
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
    vscode.debug.onDidReceiveDebugSessionCustomEvent(event => {
      if (event.event === 'longPrediction') {
        promptLongBreakpoint(event.session.workspaceFolder);
      }
    }),
  );
}
