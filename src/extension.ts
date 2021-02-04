/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { tmpdir } from 'os';
import * as vscode from 'vscode';
import { allDebugTypes, Commands, registerCommand } from './common/contributionUtils';
import { IFsUtils } from './common/fsUtils';
import { extensionId } from './configuration';
import { createGlobalContainer } from './ioc';
import { DelegateLauncherFactory } from './targets/delegate/delegateLauncherFactory';
import { registerAutoAttach } from './ui/autoAttach';
import { CascadeTerminationTracker } from './ui/cascadeTerminateTracker';
import { registerCompanionBrowserLaunch } from './ui/companionBrowserLaunch';
import { IDebugConfigurationProvider, IDebugConfigurationResolver } from './ui/configuration';
import { registerCustomBreakpointsUI } from './ui/customBreakpointsUI';
import { DebugLinkUi } from './ui/debugLinkUI';
import { debugNpmScript } from './ui/debugNpmScript';
import { DebugSessionTracker } from './ui/debugSessionTracker';
import { registerDebugTerminalUI } from './ui/debugTerminalUI';
import { DiagnosticsUI } from './ui/diagnosticsUI';
import { DisableSourceMapUI } from './ui/disableSourceMapUI';
import { toggleOnExperiment } from './ui/experimentEnlist';
import { LongPredictionUI } from './ui/longPredictionUI';
import { PrettyPrintTrackerFactory } from './ui/prettyPrint';
import { attachProcess, pickProcess } from './ui/processPicker';
import { registerProfilingCommand } from './ui/profiling';
import { registerRevealPage } from './ui/revealPage';
import { TerminalLinkHandler } from './ui/terminalLinkHandler';
import { toggleSkippingFile } from './ui/toggleSkippingFile';
import { VSCodeSessionManager } from './ui/vsCodeSessionManager';

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
    registerCommand(vscode.commands, Commands.DebugNpmScript, debugNpmScript),
    registerCommand(vscode.commands, Commands.PickProcess, pickProcess),
    registerCommand(vscode.commands, Commands.AttachProcess, attachProcess),
    registerCommand(vscode.commands, Commands.ToggleSkipping, toggleSkippingFile),
    registerCommand(vscode.commands, Commands.EnlistExperiment, toggleOnExperiment),
  );

  context.subscriptions.push(
    ...services
      .getAll<IDebugConfigurationResolver>(IDebugConfigurationResolver)
      .map(provider =>
        vscode.debug.registerDebugConfigurationProvider(
          provider.type,
          provider as vscode.DebugConfigurationProvider,
        ),
      ),

    ...services
      .getAll<IDebugConfigurationProvider>(IDebugConfigurationProvider)
      .map(provider =>
        vscode.debug.registerDebugConfigurationProvider(
          provider.type,
          provider as vscode.DebugConfigurationProvider,
          vscode.DebugConfigurationProviderTriggerKind !== undefined
            ? provider.triggerKind
            : undefined,
        ),
      ),
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
  registerCompanionBrowserLaunch(context);
  registerCustomBreakpointsUI(context, debugSessionTracker);
  registerDebugTerminalUI(
    context,
    services.get(DelegateLauncherFactory),
    services.get(TerminalLinkHandler),
    services.get(IFsUtils),
  );
  registerProfilingCommand(context, services);
  registerAutoAttach(context, services.get(DelegateLauncherFactory));
  registerRevealPage(context, debugSessionTracker);
  services.get(LongPredictionUI).register(context);
  services.get(DebugLinkUi).register(context);
  services.get(CascadeTerminationTracker).register(context);
  services.get(DisableSourceMapUI).register(context);
  services.get(DiagnosticsUI).register(context);
}

export function deactivate() {
  // nothing to do, yet...
}
