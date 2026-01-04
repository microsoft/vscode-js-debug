/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { Commands, DebugType, registerCommand } from '../common/contributionUtils';
import { DebugSessionTracker } from './debugSessionTracker';

const isBrowserSession = (session: vscode.DebugSession) =>
  session.type === DebugType.Chrome || session.type === DebugType.Edge;

export const registerFocusEmulation = (
  context: vscode.ExtensionContext,
  tracker: DebugSessionTracker,
) => {
  const pickSession = () =>
    DebugSessionTracker.pickSession(
      tracker.getConcreteSessions().filter(isBrowserSession),
      l10n.t('Select a session to emulate a focused page'),
    );

  const getTargetSession = () => {
    const active = vscode.debug.activeDebugSession;
    if (active && isBrowserSession(active)) {
      if (DebugSessionTracker.isConcreteSession(active)) {
        return active;
      }

      const children = tracker.getChildren(active).filter(isBrowserSession);
      if (children.length === 1) {
        return children[0];
      }
    }

    return pickSession();
  };

  context.subscriptions.push(
    registerCommand(vscode.commands, Commands.EmulateFocusedPage, async () => {
      const session = await getTargetSession();
      if (!session) {
        return;
      }

      try {
        await session.customRequest('setFocusEmulationEnabled', {});
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(message);
      }
    }),
  );
};
