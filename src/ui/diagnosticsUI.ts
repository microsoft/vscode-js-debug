/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import { Commands, registerCommand } from '../common/contributionUtils';
import { ExtensionLocation } from '../ioc-extras';

const localize = nls.loadMessageBundle();

@injectable()
export class DiagnosticsUI {
  constructor(@inject(ExtensionLocation) private readonly location: ExtensionLocation) {}

  public register(context: vscode.ExtensionContext) {
    context.subscriptions.push(
      registerCommand(vscode.commands, Commands.CreateDiagnostics, async () => {
        const { file } = await vscode.debug.activeDebugSession?.customRequest('createDiagnostics');
        if (this.location === 'remote' || !(await vscode.env.openExternal(vscode.Uri.file(file)))) {
          await vscode.env.clipboard.writeText(file);
          await vscode.window.showInformationMessage(
            localize(
              'createDiagnostics.copied',
              'The path to the diagnostic report has been copied to your clipboard',
            ),
          );
        }
      }),
    );
  }
}
