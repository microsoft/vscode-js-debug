/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import * as l10n from '@vscode/l10n';
import { Container } from 'inversify';
import * as vscode from 'vscode';
import { IPortLeaseTracker } from '../adapter/portLeaseTracker';
import { Commands, Configuration, readConfig, registerCommand } from '../common/contributionUtils';
import { ProxyLogger } from '../common/logging/proxyLogger';
import { FS } from '../ioc-extras';
import { DelegateLauncherFactory } from '../targets/delegate/delegateLauncherFactory';
import {
  AutoAttachLauncher,
  AutoAttachPreconditionFailed,
} from '../targets/node/autoAttachLauncher';
import { NodeBinaryProvider } from '../targets/node/nodeBinaryProvider';
import { noPackageJsonProvider } from '../targets/node/packageJsonProvider';
import { NodeOnlyPathResolverFactory } from '../targets/sourcePathResolverFactory';
import { launchVirtualTerminalParent } from './debugTerminalUI';

export function registerAutoAttach(
  context: vscode.ExtensionContext,
  delegate: DelegateLauncherFactory,
  services: Container,
) {
  let launcher: Promise<AutoAttachLauncher> | undefined;
  let disposeTimeout: NodeJS.Timeout | undefined;

  const acquireLauncher = () => {
    if (launcher) {
      return launcher;
    }

    launcher = (async () => {
      const logger = new ProxyLogger();
      // TODO: Figure out how to inject FsUtils
      const inst = new AutoAttachLauncher(
        new NodeBinaryProvider(logger, services.get(FS), noPackageJsonProvider),
        logger,
        context,
        services.get(FS),
        services.get(NodeOnlyPathResolverFactory),
        services.get(IPortLeaseTracker),
      );

      await launchVirtualTerminalParent(
        delegate,
        inst,
        readConfig(vscode.workspace, Configuration.TerminalDebugConfig),
      );

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
          const details = l10n.t('Details');
          if ((await vscode.window.showErrorMessage(e.message, details)) === details) {
            vscode.env.openExternal(vscode.Uri.parse(e.helpLink));
          }
        } else {
          await vscode.window.showErrorMessage(e.message);
        }
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      launcher?.then(l => l.refreshVariables());
    }),
    registerCommand(vscode.commands, Commands.AutoAttachToProcess, async info => {
      try {
        const launcher = await acquireLauncher();
        launcher.spawnForChild(info);
      } catch (err) {
        console.error(err);
        vscode.window.showErrorMessage(`Error activating auto attach: ${err.stack || err}`);
      }
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
