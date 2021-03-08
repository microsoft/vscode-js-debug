/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import { join } from 'path';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import { ExtensionContext, IExtensionContribution } from '../ioc-extras';

const localize = nls.loadMessageBundle();

const omitLongPredictionKey = 'omitLongPredictions';

@injectable()
export class LongPredictionUI implements IExtensionContribution {
  constructor(@inject(ExtensionContext) private readonly context: vscode.ExtensionContext) {}

  /**
   * Registers the link UI for the extension.
   */
  public register(context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.debug.onDidReceiveDebugSessionCustomEvent(event => {
        if (event.event === 'longPrediction') {
          this.promptLongBreakpoint(event.session.workspaceFolder);
        }
      }),
    );
  }
  private async promptLongBreakpoint(workspaceFolder?: vscode.WorkspaceFolder) {
    if (this.context.workspaceState.get(omitLongPredictionKey)) {
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
      this.context.workspaceState.update(omitLongPredictionKey, true);
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
}
