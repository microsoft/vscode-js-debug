/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';

import { createGlobalContainer } from './ioc';
import { registerDebugTerminalUI } from './ui/debugTerminalUI';
import { registerPrettyPrintActions } from './ui/prettyPrintUI';
import { SessionManager } from './ui/sessionManager';
import { DebugSessionTracker } from './ui/debugSessionTracker';
import { Contributions, registerCommand, allDebugTypes } from './common/contributionUtils';
import { pickProcess, attachProcess } from './ui/processPicker';
import { debugNpmScript } from './ui/debugNpmScript';
import { registerCustomBreakpointsUI } from './ui/customBreakpointsUI';
import { registerLongBreakpointUI } from './ui/longPredictionUI';
import { toggleSkippingFile } from './ui/toggleSkippingFile';
import { registerNpmScriptLens } from './ui/npmScriptLens';
import { DelegateLauncherFactory } from './targets/delegate/delegateLauncherFactory';
import { IDebugConfigurationProvider } from './ui/configuration';

export function activate(context: vscode.ExtensionContext) {
  const services = createGlobalContainer({
    storagePath: context.storagePath || context.extensionPath,
    isVsCode: true,
    context,
  });

  context.subscriptions.push(
    registerCommand(vscode.commands, Contributions.DebugNpmScript, debugNpmScript),
    registerCommand(vscode.commands, Contributions.PickProcessCommand, pickProcess),
    registerCommand(vscode.commands, Contributions.AttachProcessCommand, attachProcess),
    registerCommand(vscode.commands, Contributions.ToggleSkippingCommand, toggleSkippingFile),
  );

  context.subscriptions.push(
    ...services
      .getAll<IDebugConfigurationProvider>(IDebugConfigurationProvider)
      .map(provider => vscode.debug.registerDebugConfigurationProvider(provider.type, provider)),
  );

  const sessionManager = new SessionManager(services);
  context.subscriptions.push(
    ...[...allDebugTypes].map(type =>
      vscode.debug.registerDebugAdapterDescriptorFactory(type, sessionManager),
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
  registerDebugTerminalUI(context, services.get(DelegateLauncherFactory));
  registerNpmScriptLens(context);
}

export function deactivate() {
  // nothing to do, yet...
}
