/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import {
  Contributions,
  registerCommand,
  readConfig,
  Configuration,
} from '../common/contributionUtils';
import { TerminalNodeLauncher } from '../targets/node/terminalNodeLauncher';
import { NodePathProvider } from '../targets/node/nodePathProvider';
import { ITarget } from '../targets/targets';
import { DelegateLauncherFactory } from '../targets/delegate/delegateLauncherFactory';
import { applyDefaults, ITerminalLaunchConfiguration } from '../configuration';
import { NeverCancelled } from '../common/cancellation';
import { createPendingDapApi } from '../dap/pending-api';
import { TelemetryReporter } from '../telemetry/telemetryReporter';
import { MutableTargetOrigin } from '../targets/targetOrigin';

/**
 * See docblocks on {@link DelegateLauncher} for more information on
 * how this works.
 */
function launchTerminal(
  delegate: DelegateLauncherFactory,
  command?: string,
  workspaceFolder?: vscode.WorkspaceFolder,
) {
  const launcher = new TerminalNodeLauncher(new NodePathProvider());
  const telemetry = new TelemetryReporter();
  const baseDebugOptions: Partial<ITerminalLaunchConfiguration> = {
    ...readConfig(vscode.workspace.getConfiguration(), Configuration.TerminalDebugConfig),
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

  launcher.onTargetListChanged(() => {
    const newTargets = new Set<ITarget>();
    for (const target of launcher.targetList()) {
      newTargets.add(target);

      if (previousTargets.has(target)) {
        previousTargets.delete(target);
        continue;
      }

      const delegateId = delegate.addDelegate(target, dap, target.parent());
      if (!target.parent()) {
        vscode.debug.startDebugging(
          workspaceFolder,
          applyDefaults({
            ...baseDebugOptions,
            type: Contributions.TerminalDebugType,
            name: 'Node.js Process',
            request: 'attach',
            delegateId,
          }),
        );
      }
    }

    for (const target of previousTargets) {
      delegate.removeDelegate(target);
    }

    previousTargets = newTargets;
  });

  // Create a 'fake' launch request to the terminal, and run it!
  launcher.launch(
    applyDefaults({
      ...baseDebugOptions,
      type: Contributions.TerminalDebugType,
      name: 'Debugger Terminal',
      request: 'launch',
      command,
    }),
    {
      dap,
      telemetryReporter: telemetry,
      cancellationToken: NeverCancelled,
      get targetOrigin() {
        // Use a getter so that each new session receives a new mutable origin.
        // This is needed so that processes booted in paralle each get their
        // own apparent debug session.
        return new MutableTargetOrigin('<unset>');
      },
    },
  );

  return Promise.resolve();
}

/**
 * Registers a command to launch the debugger terminal.
 */
export function registerDebugTerminalUI(
  context: vscode.ExtensionContext,
  delegateFactory: DelegateLauncherFactory,
) {
  context.subscriptions.push(
    registerCommand(vscode.commands, Contributions.CreateDebuggerTerminal, (command, folder) =>
      launchTerminal(delegateFactory, command, folder ?? vscode.workspace.workspaceFolders?.[0]),
    ),
  );
}
