/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import { promises as fs } from 'fs';
import { registerCommand, Commands } from '../common/contributionUtils';
import {
  AutoAttachLauncher,
  AutoAttachPreconditionFailed,
} from '../targets/node/autoAttachLauncher';
import { NodeBinaryProvider } from '../targets/node/nodeBinaryProvider';
import { launchVirtualTerminalParent } from './debugTerminalUI';
import { DelegateLauncherFactory } from '../targets/delegate/delegateLauncherFactory';
import { ProxyLogger } from '../common/logging/proxyLogger';

const localize = nls.loadMessageBundle();

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
      const logger = new ProxyLogger();
      const inst = new AutoAttachLauncher(new NodeBinaryProvider(logger, fs), logger, context, fs);
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
      try {
        const launcher = await acquireLauncher();
        return { ipcAddress: launcher.deferredSocketName as string };
      } catch (e) {
        if (e instanceof AutoAttachPreconditionFailed && e.helpLink) {
          const details = localize('details', 'Details');
          if ((await vscode.window.showErrorMessage(e.message, details)) === details) {
            vscode.env.openExternal(vscode.Uri.parse(e.helpLink));
          }
        } else {
          await vscode.window.showErrorMessage(e.message);
        }
      }
    }),
    registerCommand(vscode.commands, Commands.AutoAttachToProcess, async info => {
      const launcher = await acquireLauncher();
      launcher.spawnForChild(info);
    }),
    registerCommand(vscode.commands, Commands.AutoAttachClearVariables, async () => {
      AutoAttachLauncher.clearVariables(context);

      const inst = await launcher;
      if (inst) {
        inst.terminate();
        launcher = undefined;
      }
    }),
  );
}
