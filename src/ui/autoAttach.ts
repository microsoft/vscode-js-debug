/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import * as vscode from 'vscode';
import { registerCommand, Commands } from '../common/contributionUtils';
import { AutoAttachLauncher } from '../targets/node/autoAttachLauncher';
import { NodePathProvider } from '../targets/node/nodePathProvider';
import { Logger } from '../common/logging/logger';
import { launchVirtualTerminalParent } from './debugTerminalUI';
import { DelegateLauncherFactory } from '../targets/delegate/delegateLauncherFactory';

export function registerAutoAttach(
  context: vscode.ExtensionContext,
  delegate: DelegateLauncherFactory,
) {
  let launcher: Promise<AutoAttachLauncher> | undefined;
  let disposeTimeout: NodeJS.Timeout | undefined;

  const acquireLauncher = () => {
    if (launcher) {
      return launcher;
    }

    launcher = (async () => {
      const inst = new AutoAttachLauncher(new NodePathProvider(), new Logger());
      await launchVirtualTerminalParent(delegate, inst);

      inst.onTargetListChanged(() => {
        if (inst.targetList().length === 0 && !disposeTimeout) {
          disposeTimeout = setTimeout(() => {
            launcher = undefined;
            inst.terminate();
          }, 5 * 60 * 1000);
        } else if (disposeTimeout) {
          clearTimeout(disposeTimeout);
          disposeTimeout = undefined;
        }
      });

      return inst;
    })();

    return launcher;
  };

  context.subscriptions.push(
    registerCommand(vscode.commands, Commands.AutoAttachSetVariables, async () => {
      const launcher = await acquireLauncher();
      return { ipcAddress: launcher.deferredSocketName as string };
    }),
    registerCommand(vscode.commands, Commands.AutoAttachToProcess, async info => {
      const launcher = await acquireLauncher();
      launcher.spawnForChild(info);
    }),
    registerCommand(vscode.commands, Commands.AutoAttachClearVariables, async () => {
      AutoAttachLauncher.clearVariables();
    }),
  );
}
