/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';

import { registerDebugScriptActions } from './ui/debugScriptUI';
import { registerPrettyPrintActions } from './ui/prettyPrintUI';
import { SessionManager } from './ui/sessionManager';
import { DebugSessionTracker } from './ui/debugSessionTracker';
import { NodeDebugConfigurationProvider } from './nodeDebugConfigurationProvider';
import { ChromeDebugConfigurationProvider } from './chromeDebugConfigurationProvider';
import { Contributions } from './common/contributionUtils';
import { pickProcess, attachProcess } from './ui/processPicker';
import { ExtensionHostConfigurationProvider } from './extensionHostConfigurationProvider';
import { TerminalDebugConfigurationProvider } from './terminalDebugConfigurationProvider';
import { debugNpmScript } from './ui/debugNpmScript';
import { registerCustomBreakpointsUI } from './ui/customBreakpointsUI';
import { registerLongBreakpointUI } from './ui/longPredictionUI';
import { toggleSkippingFile } from './ui/toggleSkippingFile';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(Contributions.PickProcessCommand, pickProcess),
    vscode.commands.registerCommand(Contributions.AttachProcessCommand, attachProcess),
    vscode.commands.registerCommand(Contributions.DebugNpmScript, debugNpmScript),
    vscode.commands.registerCommand(Contributions.ToggleSkippingCommand, toggleSkippingFile)
  );

  const extensionConfigProvider = new ExtensionHostConfigurationProvider(context);
  const nodeConfigProvider = new NodeDebugConfigurationProvider(context);
  const terminalConfigProvider = new TerminalDebugConfigurationProvider(context);
  const chromeConfigProvider = new ChromeDebugConfigurationProvider(
    context,
    nodeConfigProvider,
    terminalConfigProvider,
  );

  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(
      Contributions.NodeDebugType,
      nodeConfigProvider,
    ),
    vscode.debug.registerDebugConfigurationProvider(
      Contributions.ChromeDebugType,
      chromeConfigProvider,
    ),
    vscode.debug.registerDebugConfigurationProvider(
      Contributions.ExtensionHostDebugType,
      extensionConfigProvider,
    ),
    vscode.debug.registerDebugConfigurationProvider(
      Contributions.TerminalDebugType,
      terminalConfigProvider,
    ),
  );

  const sessionManager = new SessionManager(context);
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(Contributions.NodeDebugType, sessionManager),
    vscode.debug.registerDebugAdapterDescriptorFactory(
      Contributions.TerminalDebugType,
      sessionManager,
    ),
    vscode.debug.registerDebugAdapterDescriptorFactory(
      Contributions.ExtensionHostDebugType,
      sessionManager,
    ),
    vscode.debug.registerDebugAdapterDescriptorFactory(
      Contributions.ChromeDebugType,
      sessionManager,
    ),
  );
  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession(s => sessionManager.terminate(s)),
  );
  context.subscriptions.push(sessionManager);

  const debugSessionTracker = new DebugSessionTracker();
  debugSessionTracker.attach();

  registerLongBreakpointUI(context);
  registerCustomBreakpointsUI(context, debugSessionTracker);
  registerPrettyPrintActions(context, debugSessionTracker);
  registerDebugScriptActions(context);
}

export function deactivate() {
  // nothing to do, yet...
}
