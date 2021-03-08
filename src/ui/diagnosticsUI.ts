/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { Commands, Contributions, registerCommand } from '../common/contributionUtils';
import { FS, FsPromises, IExtensionContribution } from '../ioc-extras';

@injectable()
export class DiagnosticsUI implements IExtensionContribution {
  constructor(@inject(FS) private readonly fs: FsPromises) {}

  public register(context: vscode.ExtensionContext) {
    context.subscriptions.push(
      registerCommand(vscode.commands, Commands.CreateDiagnostics, async () => {
        const { file } = await vscode.debug.activeDebugSession?.customRequest('createDiagnostics');
        const panel = vscode.window.createWebviewPanel(
          Contributions.DiagnosticsView,
          'Debug Diagnostics',
          vscode.ViewColumn.Active,
          {
            enableScripts: true,
          },
        );

        panel.webview.html = await this.fs.readFile(file, 'utf-8');
      }),
    );
  }
}
