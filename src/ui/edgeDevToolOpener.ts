/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { Commands, DebugType, registerCommand } from '../common/contributionUtils';
import { IExtensionContribution } from '../ioc-extras';
import { BrowserTargetType } from '../targets/browser/browserTargets';
import { DebugSessionTracker } from './debugSessionTracker';

const qualifies = (session: vscode.DebugSession) => {
  if (session?.type !== DebugType.Edge) {
    return false;
  }

  const type: BrowserTargetType = session.configuration.__browserTargetType;
  return type === BrowserTargetType.IFrame || type === BrowserTargetType.Page;
};

const toolExtensionId = 'ms-edgedevtools.vscode-edge-devtools';
const commandId = 'vscode-edge-devtools.attachToCurrentDebugTarget';

function findRootSession(session: vscode.DebugSession): vscode.DebugSession {
  let root = session;
  while (root.parentSession) {
    root = root.parentSession;
  }
  return root;
}

@injectable()
export class EdgeDevToolOpener implements IExtensionContribution {
  constructor(@inject(DebugSessionTracker) private readonly tracker: DebugSessionTracker) {}

  /** @inheritdoc */
  public register(context: vscode.ExtensionContext) {
    context.subscriptions.push(
      registerCommand(vscode.commands, Commands.OpenEdgeDevTools, async () => {
        const session =
          vscode.debug.activeDebugSession && qualifies(vscode.debug.activeDebugSession)
            ? vscode.debug.activeDebugSession
            : await DebugSessionTracker.pickSession(
              this.tracker.getConcreteSessions().filter(qualifies),
              l10n.t('Select the page where you want to open the devtools'),
            );

        if (!session) {
          return;
        }

        const rootSession = findRootSession(session);

        try {
          return await vscode.commands.executeCommand(
            commandId,
            session.id,
            rootSession.configuration,
          );
        } catch (e) {
          if (e instanceof Error && /command .+ not found/.test(e.message)) {
            return vscode.commands.executeCommand(
              'workbench.extensions.action.showExtensionsWithIds',
              [toolExtensionId],
            );
          } else {
            throw e;
          }
        }
      }),
    );
  }
}
