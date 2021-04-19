/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import { Commands, Contributions, isDebugType, registerCommand } from '../common/contributionUtils';
import { ExtensionContext, FS, FsPromises, IExtensionContribution } from '../ioc-extras';
import { DebugSessionTracker } from './debugSessionTracker';

const localize = nls.loadMessageBundle();
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
      registerCommand(vscode.commands, Commands.CreateDiagnostics, async () =>
        this.getDiagnosticInfo(await this.getTargetSession()),
      ),

      vscode.debug.onDidReceiveDebugSessionCustomEvent(async evt => {
        if (
          evt.event !== 'suggestDiagnosticTool' ||
          this.dismissedForSession ||
          this.context.workspaceState.get(neverRemindKey) ||
          this.isPrompting
        ) {
          return;
        }

        this.isPrompting = true;

        const yes = localize('yes', 'Yes');
        const notNow = localize('notNow', 'Not Now');
        const never = localize('never', 'Never');
        const response = await vscode.window.showInformationMessage(
          'It looks like you might be having trouble with breakpoints. Would you like to open our diagnostic tool?',
          yes,
          notNow,
          never,
        );

        this.isPrompting = false;

        switch (response) {
          case yes:
            this.getDiagnosticInfo(await this.getTargetSession());
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
    const candidates = this.tracker.getConcreteSessions();
    if (candidates.length < 2) {
      return candidates[0];
    }

    const qp = vscode.window.createQuickPick<{ id: string; label: string }>();
    qp.title = localize('selectInspectSession', 'Select the session you want to inspect:');
    qp.items = candidates.map(c => ({ label: c.name, id: c.id }));
    qp.ignoreFocusOut = true;

    return new Promise<vscode.DebugSession | undefined>(resolve => {
      qp.onDidAccept(() => resolve(candidates.find(i => i.id === qp.selectedItems[0]?.id)));
      qp.onDidHide(() => resolve(undefined));
      qp.show();
    }).finally(() => qp.dispose());
  }

  private async getDiagnosticInfo(session: vscode.DebugSession | undefined) {
    if (!session || !this.tracker.isRunning(session)) {
      vscode.window.showErrorMessage(
        localize(
          'inspectSessionEnded',
          'It looks like your debug session has already ended. Try debugging again, then run the "Debug: Diagnose Breakpoint Problems" command.',
        ),
      );

      return;
    }

    const { file } = await session.customRequest('createDiagnostics');
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
