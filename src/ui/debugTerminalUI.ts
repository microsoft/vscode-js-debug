/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { Container } from 'inversify';
import { homedir } from 'os';
import * as vscode from 'vscode';
import { IPortLeaseTracker } from '../adapter/portLeaseTracker';
import { NeverCancelled } from '../common/cancellation';
import {
  Commands,
  Configuration,
  DebugType,
  readConfig,
  registerCommand,
} from '../common/contributionUtils';
import { EventEmitter } from '../common/events';
import { ProxyLogger } from '../common/logging/proxyLogger';
import { ITerminalLinkProvider } from '../common/terminalLinkProvider';
import {
  applyDefaults,
  ITerminalLaunchConfiguration,
  terminalBaseDefaults,
} from '../configuration';
import { createPendingDapApi } from '../dap/pending-api';
import { FS } from '../ioc-extras';
import { DelegateLauncherFactory } from '../targets/delegate/delegateLauncherFactory';
import { NodeBinaryProvider } from '../targets/node/nodeBinaryProvider';
import { noPackageJsonProvider } from '../targets/node/packageJsonProvider';
import { ITerminalLauncherLike, TerminalNodeLauncher } from '../targets/node/terminalNodeLauncher';
import { NodeOnlyPathResolverFactory } from '../targets/sourcePathResolverFactory';
import { MutableTargetOrigin } from '../targets/targetOrigin';
import { ITarget } from '../targets/targets';
import { DapTelemetryReporter } from '../telemetry/dapTelemetryReporter';

export const launchVirtualTerminalParent = (
  delegate: DelegateLauncherFactory,
  launcher: ITerminalLauncherLike,
  options: Partial<ITerminalLaunchConfiguration> = {},
  filterTarget: (target: ITarget) => boolean = () => true,
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
    const trusted = await vscode.workspace.requestWorkspaceTrust();
    const newTargets = new Set<ITarget>();
    for (const target of launcher.targetList()) {
      newTargets.add(target);

      if (previousTargets.has(target)) {
        previousTargets.delete(target);
        continue;
      }

      const delegateId = delegate.addDelegate(target, dap, target.parent());

      // Skip targets the consumer asked to filter out.
      if (!filterTarget(target)) {
        target.detach();
        continue;
      }

      // Check that we didn't detach from the parent session.
      if (target.targetInfo.openerId && !target.parent()) {
        target.detach();
        continue;
      }

      // Detach from targets if workspace trust was not granted
      if (!trusted) {
        target.detach();
        continue;
      }

      if (!target.parent()) {
        const cwd = await getWorkingDirectory(target);
        vscode.debug.startDebugging(cwd && vscode.workspace.getWorkspaceFolder(cwd), {
          ...baseDebugOptions,
          type: DebugType.Terminal,
          name: 'Node.js Process',
          request: 'attach',
          delegateId,
          cwd: cwd?.fsPath,
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

const Abort = Symbol('Abort');

const home = homedir();
const tildify: (s: string) => string = process.platform === 'win32'
  ? s => s
  : s => (s.startsWith(home) ? `~${s.slice(home.length)}` : s);

async function getWorkspaceFolder() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length < 2) {
    return folders?.[0];
  }

  const picked = await vscode.window.showQuickPick(
    folders.map(folder => ({
      label: folder.name,
      description: tildify(folder.uri.fsPath),
      folder,
    })),
    {
      placeHolder: l10n.t('Select current working directory for new terminal'),
    },
  );

  return picked?.folder ?? Abort;
}

class ProfileTerminalLauncher extends TerminalNodeLauncher {
  private optionsReadyEmitter = new EventEmitter<vscode.TerminalOptions>();
  public readonly onOptionsReady = this.optionsReadyEmitter.event;

  /** @override */
  protected createTerminal(options: vscode.TerminalOptions) {
    this.optionsReadyEmitter.fire(options);
    return new Promise<vscode.Terminal>(resolve => {
      const listener = vscode.window.onDidOpenTerminal(t => {
        listener.dispose();
        resolve(t);
      });
    });
  }
}

/**
 * Registers a command to launch the debugger terminal.
 */
export function registerDebugTerminalUI(
  context: vscode.ExtensionContext,
  delegateFactory: DelegateLauncherFactory,
  services: Container,
) {
  const terminals = new Map<
    vscode.Terminal,
    { launcher: TerminalNodeLauncher; folder?: vscode.WorkspaceFolder; cwd?: string }
  >();

  const createLauncher = (logger: ProxyLogger, binary: NodeBinaryProvider) =>
    new TerminalNodeLauncher(
      binary,
      logger,
      services.get(FS),
      services.get(NodeOnlyPathResolverFactory),
      services.get(IPortLeaseTracker),
      services.get(ITerminalLinkProvider),
    );

  /**
   * See docblocks on {@link DelegateLauncher} for more information on
   * how this works.
   */
  async function launchTerminal(
    delegate: DelegateLauncherFactory,
    command?: string,
    workspaceFolder?: vscode.WorkspaceFolder,
    defaultConfig?: Partial<ITerminalLaunchConfiguration>,
    createLauncherFn = createLauncher,
  ) {
    if (!workspaceFolder) {
      const picked = await getWorkspaceFolder();
      if (picked === Abort) {
        return;
      }

      workspaceFolder = picked;
    }

    // try to reuse a terminal if invoked programmatically to run a command
    if (command) {
      for (const [terminal, config] of terminals) {
        if (
          config.folder === workspaceFolder
          && config.cwd === defaultConfig?.cwd
          && !config.launcher.targetList().length
        ) {
          terminal.show(true);
          terminal.sendText(command);
          return;
        }
      }
    }

    const logger = new ProxyLogger();
    const launcher = createLauncherFn(
      logger,
      new NodeBinaryProvider(logger, services.get(FS), noPackageJsonProvider),
    );

    launcher.onTerminalCreated(terminal => {
      terminals.set(terminal, { launcher, folder: workspaceFolder, cwd: defaultConfig?.cwd });
    });

    try {
      await launchVirtualTerminalParent(
        delegate,
        launcher,
        {
          command,
          ...defaultConfig,
          __workspaceFolder: workspaceFolder?.uri.fsPath,
        },
        () => {
          for (const [terminal, rec] of terminals) {
            if (rec.launcher === launcher && terminal.state.isInteractedWith) {
              return true;
            }
          }
          return false;
        },
      );
    } catch (e) {
      vscode.window.showErrorMessage(e.message);
    }
  }

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal(terminal => {
      terminals.delete(terminal);
    }),
    registerCommand(
      vscode.commands,
      Commands.CreateDebuggerTerminal,
      (command, folder, config) => launchTerminal(delegateFactory, command, folder, config),
    ),
    vscode.window.registerTerminalProfileProvider('extension.js-debug.debugTerminal', {
      provideTerminalProfile: () =>
        new Promise<vscode.TerminalProfile>(resolve =>
          launchTerminal(delegateFactory, undefined, undefined, undefined, (logger, binary) => {
            const launcher = new ProfileTerminalLauncher(
              binary,
              logger,
              services.get(FS),
              services.get(NodeOnlyPathResolverFactory),
              services.get(IPortLeaseTracker),
              services.get(ITerminalLinkProvider),
            );

            launcher.onOptionsReady(options => resolve(new vscode.TerminalProfile(options)));

            return launcher;
          })
        ),
    }),
  );
}
