/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { promises as fs } from 'fs';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import { Commands, Configuration, readConfig, registerCommand } from '../common/contributionUtils';
import { LocalFsUtils } from '../common/fsUtils';
import { ProxyLogger } from '../common/logging/proxyLogger';
import { DelegateLauncherFactory } from '../targets/delegate/delegateLauncherFactory';
import {
  AutoAttachLauncher,
  AutoAttachPreconditionFailed,
} from '../targets/node/autoAttachLauncher';
import { NodeBinaryProvider } from '../targets/node/nodeBinaryProvider';
import { noPackageJsonProvider } from '../targets/node/packageJsonProvider';
import { launchVirtualTerminalParent } from './debugTerminalUI';

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
      // TODO: Figure out how to inject FsUtils
      const inst = new AutoAttachLauncher(
        new NodeBinaryProvider(logger, fs, noPackageJsonProvider, vscode),
        logger,
        context,
        fs,
        new LocalFsUtils(fs),
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
          const details = localize('details', 'Details');
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
