/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IExports } from '@vscode/js-debug';
import * as l10n from '@vscode/l10n';
import { tmpdir } from 'os';
import * as vscode from 'vscode';
import {
  DebugType,
  preferredDebugTypes,
} from './common/contributionUtils';
import { extensionId } from './configuration';
import { createGlobalContainer } from './ioc';
import { IDebugConfigurationProvider, IDebugConfigurationResolver } from './ui/configuration';
import { DebugSessionTracker } from './ui/debugSessionTracker';
import { ExtensionApiFactory } from './ui/extensionApi';
import { VSCodeSessionManager } from './ui/vsCodeSessionManager';

export function activate(context: vscode.ExtensionContext): IExports {
  if (vscode.l10n.bundle) {
    l10n.config({ contents: vscode.l10n.bundle });
  }

  const services = createGlobalContainer({
    // On Windows, use the os.tmpdir() since the extension storage path is too long. See:
    // https://github.com/microsoft/vscode-js-debug/issues/342
    storagePath: process.platform === 'win32'
      ? tmpdir()
      : context.storagePath || context.extensionPath,
    isVsCode: true,
    isRemote: !!process.env.JS_DEBUG_USE_COMPANION
      || vscode.extensions.getExtension(extensionId)?.extensionKind
        === vscode.ExtensionKind.Workspace,
    context,
  });

  const debugResolvers = services.getAll<IDebugConfigurationResolver>(IDebugConfigurationResolver);
  for (const resolver of debugResolvers) {
    if (resolver.type !== DebugType.Node) {
      continue;
    }
    const cast = resolver as vscode.DebugConfigurationProvider;
    context.subscriptions.push(
      vscode.debug.registerDebugConfigurationProvider(resolver.type, cast),
    );

    const preferred = preferredDebugTypes.get(resolver.type as DebugType);
    if (preferred) {
      context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider(preferred, cast),
      );
    }
  }

  const debugProviders = services.getAll<IDebugConfigurationProvider>(IDebugConfigurationProvider);
  for (const provider of debugProviders) {
    if (provider.type !== DebugType.Node) {
      continue;
    }
    vscode.debug.registerDebugConfigurationProvider(
      provider.type,
      provider as vscode.DebugConfigurationProvider,
      vscode.DebugConfigurationProviderTriggerKind !== undefined ? provider.triggerKind : undefined,
    );
  }

  const sessionManager = new VSCodeSessionManager(services);
  context.subscriptions.push(
    ...[DebugType.Node].map(type =>
      vscode.debug.registerDebugAdapterDescriptorFactory(type, sessionManager)
    ),
  );
  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession(s => sessionManager.terminate(s)),
  );
  context.subscriptions.push(sessionManager);

  const debugSessionTracker = services.get(DebugSessionTracker);
  debugSessionTracker.attach();

  return services.get(ExtensionApiFactory).create();
}

export function deactivate() {
  // nothing to do, yet...
}
