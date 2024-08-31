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
  const launchers = new Map<vscode.WorkspaceFolder | undefined, Promise<AutoAttachLauncher>>();
  let disposeTimeout: NodeJS.Timeout | undefined;

  const acquireLauncher = (workspaceFolder: vscode.WorkspaceFolder | undefined) => {
    const prev = launchers.get(workspaceFolder);
    if (prev) {
      return prev;
    }

    const launcher = (async () => {
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

      let config = readConfig(vscode.workspace, Configuration.TerminalDebugConfig);
      if (workspaceFolder) {
        const fsPath = workspaceFolder?.uri.fsPath;
        config = { ...config, cwd: fsPath, __workspaceFolder: fsPath };
      }

      await launchVirtualTerminalParent(delegate, inst, config);

      inst.onTargetListChanged(() => {
        if (inst.targetList().length === 0 && !disposeTimeout) {
          disposeTimeout = setTimeout(() => {
            launchers.delete(workspaceFolder);
            inst.terminate();
          }, 5 * 60 * 1000);
        } else if (disposeTimeout) {
          clearTimeout(disposeTimeout);
          disposeTimeout = undefined;
        }
      });

      return inst;
    })();

    launchers.set(workspaceFolder, launcher);

    return launcher;
  };

  context.subscriptions.push(
    registerCommand(vscode.commands, Commands.AutoAttachSetVariables, async () => {
      try {
        const launcher = await acquireLauncher(vscode.workspace.workspaceFolders?.[0]);
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
    registerCommand(vscode.commands, Commands.AutoAttachToProcess, async info => {
      try {
        const wf = info.scriptName
          && vscode.workspace.getWorkspaceFolder(vscode.Uri.file(info.scriptName));
        const launcher = await acquireLauncher(wf || vscode.workspace.workspaceFolders?.[0]);
        launcher.spawnForChild(info);
      } catch (err) {
        console.error(err);
        vscode.window.showErrorMessage(`Error activating auto attach: ${err.stack || err}`);
      }
    }),
    registerCommand(vscode.commands, Commands.AutoAttachClearVariables, () => {
      AutoAttachLauncher.clearVariables(context);

      for (const [key, value] of launchers.entries()) {
        launchers.delete(key);
        value.then(v => v.terminate());
      }
    }),
  );
}
