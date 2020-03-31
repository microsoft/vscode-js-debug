/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import {
  Contributions,
  registerCommand,
  readConfig,
  Configuration,
  DebugType,
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
import { Logger } from '../common/logging/logger';
import { URL } from 'url';
import { isMetaAddress } from '../common/urlUtils';

const debugTerminals = new WeakSet<vscode.Terminal>();

/**
 * See docblocks on {@link DelegateLauncher} for more information on
 * how this works.
 */
function launchTerminal(
  delegate: DelegateLauncherFactory,
  command?: string,
  workspaceFolder?: vscode.WorkspaceFolder,
) {
  const launcher = new TerminalNodeLauncher(new NodePathProvider(), new Logger());
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
            type: DebugType.Terminal,
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

  launcher.onTerminalCreated(terminal => {
    debugTerminals.add(terminal);
  });

  // Create a 'fake' launch request to the terminal, and run it!
  launcher.launch(
    applyDefaults({
      ...baseDebugOptions,
      type: DebugType.Terminal,
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
 * Launches a browser debug session when a link is clicked from a debug terminal.
 */
function handleLink(terminal: vscode.Terminal, link: string) {
  // Only handle links when the click is from inside a debug terminal, and
  // the user hasn't disabled debugging via links.
  if (!debugTerminals.has(terminal)) {
    return false;
  }

  const baseConfig = readConfig(
    vscode.workspace.getConfiguration(),
    Configuration.DebugByLinkOptions,
  );
  if (baseConfig === false) {
    return false;
  }

  // Don't debug things that explicitly aren't http, and prefix anything like `localhost:1234`
  try {
    const url = new URL(link);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return false;
    }

    if (isMetaAddress(link)) {
      url.hostname = 'localhost';
      link = url.toString();
    }
  } catch {
    link = `http://${link}`;
  }

  // Do our best to resolve the right workspace folder to launch in, and debug
  let cwd: vscode.WorkspaceFolder | undefined;
  if ('cwd' in terminal.creationOptions && terminal.creationOptions.cwd) {
    cwd = vscode.workspace.getWorkspaceFolder(
      typeof terminal.creationOptions.cwd === 'string'
        ? vscode.Uri.file(terminal.creationOptions.cwd)
        : terminal.creationOptions.cwd,
    );
  }

  if (!cwd) {
    cwd = vscode.workspace.workspaceFolders?.[0];
  }

  return vscode.debug.startDebugging(cwd, {
    ...(typeof baseConfig === 'boolean' ? {} : baseConfig),
    type: DebugType.Chrome,
    name: link,
    request: 'launch',
    url: link,
  });
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
    vscode.window.registerTerminalLinkHandler({ handleLink }),
  );
}
