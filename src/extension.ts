// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';

import { registerDebugScriptActions } from './ui/debugScriptUI';
import { registerPrettyPrintActions } from './ui/prettyPrintUI';
import { SessionManager } from './ui/sessionManager';
import { DebugSessionTracker } from './ui/debugSessionTracker';
import { NodeDebugConfigurationProvider } from './nodeDebugConfigurationProvider';
import { ChromeDebugConfigurationProvider } from './chromeDebugConfigurationProvider';
import { Contributions } from './common/contributionUtils';
import { pickProcess, attachProcess } from './ui/processPicker';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(Contributions.PickProcessCommand, pickProcess),
    vscode.commands.registerCommand(Contributions.AttachProcessCommand, attachProcess),
  );

  const nodeConfigProvider = new NodeDebugConfigurationProvider(context,);
  const chromeConfigProvider = new ChromeDebugConfigurationProvider(context, nodeConfigProvider);

  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(
      Contributions.NodeDebugType,
      nodeConfigProvider,
    ),
    vscode.debug.registerDebugConfigurationProvider(
      Contributions.ChromeDebugType,
      chromeConfigProvider,
    ),
  );

  const sessionManager = new SessionManager(context);
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(Contributions.NodeDebugType, sessionManager),
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

  registerPrettyPrintActions(context, debugSessionTracker);
  registerDebugScriptActions(context);
}

export function deactivate() {
  // nothing to do, yet...
}
