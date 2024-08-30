/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { Commands, Contributions, isDebugType, registerCommand } from '../common/contributionUtils';
import { ExtensionContext, FS, FsPromises, IExtensionContribution } from '../ioc-extras';
import { DebugSessionTracker } from './debugSessionTracker';

const neverRemindKey = 'neverRemind';

@injectable()
export class DiagnosticsUI implements IExtensionContribution {
  private dismissedForSession = false;
  private isPrompting = false;

  constructor(
    @inject(FS) private readonly fs: FsPromises,
    @inject(ExtensionContext) private readonly context: vscode.ExtensionContext,
    @inject(DebugSessionTracker) private readonly tracker: DebugSessionTracker,
  ) {}

  public register(context: vscode.ExtensionContext) {
    context.subscriptions.push(
      registerCommand(vscode.commands, Commands.GetDiagnosticLogs, async () => {
        const session = await this.getTargetSession();
        if (!session) {
          return;
        }

        const uri = await vscode.window.showSaveDialog({ filters: { JSON: ['json'] } });
        if (uri) {
          session.customRequest('saveDiagnosticLogs', {
            toFile: uri.fsPath,
          });
        }
      }),
      registerCommand(
        vscode.commands,
        Commands.CreateDiagnostics,
        async () => this.getDiagnosticInfo(await this.getTargetSession()),
      ),
      vscode.debug.onDidReceiveDebugSessionCustomEvent(async evt => {
        if (evt.event === 'openDiagnosticTool') {
          return this.openDiagnosticTool(evt.body.file);
        }

        if (
          evt.event !== 'suggestDiagnosticTool'
          || this.dismissedForSession
          || this.context.workspaceState.get(neverRemindKey)
          || this.isPrompting
        ) {
          return;
        }

        this.isPrompting = true;

        const yes = l10n.t('Yes');
        const notNow = l10n.t('Not Now');
        const never = l10n.t('Never');
        const response = await vscode.window.showInformationMessage(
          'It looks like you might be having trouble with breakpoints. Would you like to open our diagnostic tool?',
          yes,
          notNow,
          never,
        );

        this.isPrompting = false;

        switch (response) {
          case yes:
            this.getDiagnosticInfo(await this.getTargetSession(), true);
            break;
          case never:
            context.workspaceState.update(neverRemindKey, true);
            break;
          case notNow:
            this.dismissedForSession = true;
            break;
        }
      }),
    );
  }

  private getTargetSession() {
    const active = vscode.debug.activeDebugSession;
    if (!active || !isDebugType(active?.type)) {
      return this.pickSession();
    }

    if (DebugSessionTracker.isConcreteSession(active)) {
      return active;
    }

    const children = this.tracker.getChildren(active);
    if (children.length === 1) {
      return children[0];
    }

    return this.pickSession();
  }

  private pickSession() {
    return DebugSessionTracker.pickSession(
      this.tracker.getConcreteSessions(),
      l10n.t('Select the session you want to inspect:'),
    );
  }

  private async getDiagnosticInfo(
    session: vscode.DebugSession | undefined,
    fromSuggestion = false,
  ) {
    if (!session || !this.tracker.isRunning(session)) {
      vscode.window.showErrorMessage(
        l10n.t(
          'It looks like your debug session has already ended. Try debugging again, then run the "Debug: Diagnose Breakpoint Problems" command.',
        ),
      );

      return;
    }

    const { file } = await session.customRequest('createDiagnostics', { fromSuggestion });
    await this.openDiagnosticTool(file);
  }

  private async openDiagnosticTool(file: string) {
    const panel = vscode.window.createWebviewPanel(
      Contributions.DiagnosticsView,
      'Debug Diagnostics',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
      },
    );

    panel.webview.html = await this.fs.readFile(file, 'utf-8');
  }
}
