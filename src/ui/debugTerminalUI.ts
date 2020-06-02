/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import {
  registerCommand,
  readConfig,
  Configuration,
  DebugType,
  Commands,
} from '../common/contributionUtils';
import { TerminalNodeLauncher, ITerminalLauncherLike } from '../targets/node/terminalNodeLauncher';
import { NodeBinaryProvider } from '../targets/node/nodeBinaryProvider';
import { ITarget } from '../targets/targets';
import { DelegateLauncherFactory } from '../targets/delegate/delegateLauncherFactory';
import {
  applyDefaults,
  ITerminalLaunchConfiguration,
  terminalBaseDefaults,
} from '../configuration';
import { NeverCancelled } from '../common/cancellation';
import { createPendingDapApi } from '../dap/pending-api';
import { MutableTargetOrigin } from '../targets/targetOrigin';
import { DapTelemetryReporter } from '../telemetry/dapTelemetryReporter';
import { TerminalLinkHandler } from './terminalLinkHandler';
import { promises as fs } from 'fs';
import { ProxyLogger } from '../common/logging/proxyLogger';

export const launchVirtualTerminalParent = (
  delegate: DelegateLauncherFactory,
  launcher: ITerminalLauncherLike,
  options: Partial<ITerminalLaunchConfiguration> = {},
) => {
  const telemetry = new DapTelemetryReporter();
  const baseDebugOptions: Partial<ITerminalLaunchConfiguration> = {
    ...readConfig(vscode.workspace, Configuration.TerminalDebugConfig),
    // Prevent switching over the the Debug Console whenever a process starts
    internalConsoleOptions: 'neverOpen',
  };

  // We don't have a debug session initially when we launch the terminal, so,
  // we create a shell DAP instance that queues messages until it gets attached
  // to a connection. Terminal processes don't use this too much except for
  // telemetry.
  const dap = createPendingDapApi();
  telemetry.attachDap(dap);

  // Watch the set of targets we get from this terminal launcher. Remember
  // that we can get targets from child processes of session too. When we
  // get a new top-level target (one without a parent session), start
  // debugging. Removing delegated targets will automatically end debug
  // sessions. Once all are removed, reset the DAP since we'll get a new
  // instance for the next process that starts.
  let previousTargets = new Set<ITarget>();

  // Gets the ideal workspace folder for the given process.
  const getWorkingDirectory = async (target: ITarget) => {
    const telemetry = await launcher.getProcessTelemetry(target);
    const fromTelemetry = telemetry && vscode.Uri.file(telemetry.cwd);
    const preferred = fromTelemetry && vscode.workspace.getWorkspaceFolder(fromTelemetry);
    if (preferred) {
      return preferred.uri;
    }

    if (options.__workspaceFolder) {
      return vscode.Uri.file(options.__workspaceFolder);
    }

    return vscode.workspace.workspaceFolders?.[0].uri ?? fromTelemetry;
  };

  launcher.onTargetListChanged(async () => {
    const newTargets = new Set<ITarget>();
    for (const target of launcher.targetList()) {
      newTargets.add(target);

      if (previousTargets.has(target)) {
        previousTargets.delete(target);
        continue;
      }

      const delegateId = delegate.addDelegate(target, dap, target.parent());
      if (!target.parent()) {
        const cwd = await getWorkingDirectory(target);
        vscode.debug.startDebugging(cwd && vscode.workspace.getWorkspaceFolder(cwd), {
          ...baseDebugOptions,
          type: DebugType.Terminal,
          name: 'Node.js Process',
          request: 'attach',
          delegateId,
          __workspaceFolder: cwd,
        });
      }
    }

    for (const target of previousTargets) {
      delegate.removeDelegate(target);
    }

    previousTargets = newTargets;
  });

  // Create a 'fake' launch request to the terminal, and run it!
  return launcher.launch(
    applyDefaults({
      ...baseDebugOptions,
      type: DebugType.Terminal,
      name: terminalBaseDefaults.name,
      request: 'launch',
      ...options,
    }),
    {
      dap,
      telemetryReporter: telemetry,
      cancellationToken: NeverCancelled,
      get targetOrigin() {
        // Use a getter so that each new session receives a new mutable origin.
        // This is needed so that processes booted in parallel each get their
        // own apparent debug session.
        return new MutableTargetOrigin('<unset>');
      },
    },
  );
};

/**
 * Registers a command to launch the debugger terminal.
 */
export function registerDebugTerminalUI(
  context: vscode.ExtensionContext,
  delegateFactory: DelegateLauncherFactory,
  linkHandler: TerminalLinkHandler,
) {
  /**
   * See docblocks on {@link DelegateLauncher} for more information on
   * how this works.
   */
  function launchTerminal(
    delegate: DelegateLauncherFactory,
    command?: string,
    workspaceFolder?: vscode.WorkspaceFolder,
    defaultConfig?: Partial<ITerminalLaunchConfiguration>,
  ) {
    const launcher = new TerminalNodeLauncher(new NodeBinaryProvider(), new ProxyLogger(), fs);
    launcher.onTerminalCreated(terminal => {
      linkHandler.enableHandlingInTerminal(terminal);
    });

    launchVirtualTerminalParent(delegate, launcher, {
      command,
      ...defaultConfig,
      __workspaceFolder: workspaceFolder?.uri.fsPath,
    });

    return Promise.resolve();
  }

  context.subscriptions.push(
    registerCommand(vscode.commands, Commands.CreateDebuggerTerminal, (command, folder, config) =>
      launchTerminal(
        delegateFactory,
        command,
        folder ?? vscode.workspace.workspaceFolders?.[0],
        config,
      ),
    ),
    vscode.window.registerTerminalLinkHandler?.(linkHandler),
  );
}
