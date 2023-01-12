/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { inject, injectable } from 'inversify';
import { join } from 'path';
import * as vscode from 'vscode';
import { ExtensionContext, IExtensionContribution } from '../ioc-extras';

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

    const message = l10n.t(
      "It's taking a while to configure your breakpoints. You can speed this up by updating the 'outFiles' in your launch.json.",
    );
    const openLaunch = l10n.t('Open launch.json');
    const dontShow = l10n.t("Don't show again");
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
      await vscode.window.showWarningMessage(l10n.t('No workspace folder open.'));
      return;
    }

    const doc = await vscode.workspace.openTextDocument(
      join(workspaceFolder.uri.fsPath, '.vscode', 'launch.json'),
    );
    await vscode.window.showTextDocument(doc);
  }
}
