/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';

import { createGlobalContainer } from './ioc';
import { registerDebugTerminalUI } from './ui/debugTerminalUI';
import { VSCodeSessionManager } from './ui/vsCodeSessionManager';
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
import { registerCompanionBrowserLaunch } from './ui/companionBrowserLaunch';
import { tmpdir } from 'os';
import { PrettyPrintTrackerFactory } from './ui/prettyPrint';
import { toggleOnExperiment } from './ui/experimentEnlist';
import { registerProfilingCommand } from './ui/profiling';
import { TerminalLinkHandler } from './ui/terminalLinkHandler';

// eslint-disable-next-line
const packageJson = require('../package.json');
const extensionId = `${packageJson.publisher}.${packageJson.name}`;

export function activate(context: vscode.ExtensionContext) {
  const services = createGlobalContainer({
    // On Windows, use the os.tmpdir() since the extension storage path is too long. See:
    // https://github.com/microsoft/vscode-js-debug/issues/342
    storagePath:
      process.platform === 'win32' ? tmpdir() : context.storagePath || context.extensionPath,
    isVsCode: true,
    isRemote:
      !!process.env.JS_DEBUG_USE_COMPANION ||
      vscode.extensions.getExtension(extensionId)?.extensionKind === vscode.ExtensionKind.Workspace,
    context,
  });

  context.subscriptions.push(
    registerCommand(vscode.commands, Contributions.DebugNpmScript, debugNpmScript),
    registerCommand(vscode.commands, Contributions.PickProcessCommand, pickProcess),
    registerCommand(vscode.commands, Contributions.AttachProcessCommand, attachProcess),
    registerCommand(vscode.commands, Contributions.ToggleSkippingCommand, toggleSkippingFile),
    registerCommand(vscode.commands, Contributions.EnlistExperimentCommand, toggleOnExperiment),
  );

  context.subscriptions.push(
    ...services
      .getAll<IDebugConfigurationProvider>(IDebugConfigurationProvider)
      .map(provider => vscode.debug.registerDebugConfigurationProvider(provider.type, provider)),
  );

  const sessionManager = new VSCodeSessionManager(services);
  context.subscriptions.push(
    ...[...allDebugTypes].map(type =>
      vscode.debug.registerDebugAdapterDescriptorFactory(type, sessionManager),
    ),
  );
  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession(s => sessionManager.terminate(s)),
  );
  context.subscriptions.push(sessionManager);

  const debugSessionTracker = services.get(DebugSessionTracker);
  debugSessionTracker.attach();

  context.subscriptions.push(PrettyPrintTrackerFactory.register(debugSessionTracker));
  registerLongBreakpointUI(context);
  registerCompanionBrowserLaunch(context);
  registerCustomBreakpointsUI(context, debugSessionTracker);
  registerDebugTerminalUI(
    context,
    services.get(DelegateLauncherFactory),
    services.get(TerminalLinkHandler),
  );
  registerNpmScriptLens(context);
  registerProfilingCommand(context, services);
}

export function deactivate() {
  // nothing to do, yet...
}
