/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Container } from 'inversify';
import * as net from 'net';
import * as vscode from 'vscode';
import { IDisposable } from '../common/events';
import { pick } from '../common/objUtils';
import { IPseudoAttachConfiguration } from '../configuration';
import { ServerSessionManager } from '../serverSessionManager';
import { ISessionLauncher, RootSession, Session } from '../sessionManager';
import { ITarget } from '../targets/targets';

const preservedProperties = [
  // Preserve the `serverReadyAction` so that stdio from child sessions is parsed
  // and processed: https://github.com/microsoft/vscode-js-debug/issues/362
  'serverReadyAction',
];

/**
 * Session launcher which uses vscode's `startDebugging` method to start a new debug session
 * @param parentSession The parent debug session to pass to `startDebugging`
 * @param config Launch configuration for the new debug session
 */
class VsCodeSessionLauncher implements ISessionLauncher<vscode.DebugSession> {
  launch(
    parentSession: Session<vscode.DebugSession>,
    target: ITarget,
    config: IPseudoAttachConfiguration,
  ) {
    vscode.debug.startDebugging(
      parentSession.debugSession.workspaceFolder,
      {
        ...config,
        ...pick(parentSession.debugSession.configuration, preservedProperties),
        ...target.supplementalConfig,
        __parentId: parentSession.debugSession.id,
      } as vscode.DebugConfiguration,
      {
        parentSession: parentSession.debugSession,
        consoleMode: vscode.DebugConsoleMode.MergeWithParent,
        noDebug: parentSession.debugSession.configuration.noDebug,
        compact: parentSession instanceof RootSession, // don't compact workers/child processes
      },
    );
  }
}

/**
 * VS Code specific session manager which also implements the DebugAdapterDescriptorFactory
 * interface
 */
export class VSCodeSessionManager implements vscode.DebugAdapterDescriptorFactory, IDisposable {
  private readonly sessionServerManager: ServerSessionManager<vscode.DebugSession>;

  constructor(globalContainer: Container) {
    this.sessionServerManager = new ServerSessionManager(
      globalContainer,
      new VsCodeSessionLauncher(),
    );
  }

  /**
   * @inheritdoc
   */
  public createDebugAdapterDescriptor(
    debugSession: vscode.DebugSession,
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    const result = this.sessionServerManager.createDebugServer(debugSession);
    return new vscode.DebugAdapterServer((result.server.address() as net.AddressInfo).port);
  }

  /**
   * @inheritdoc
   */
  public terminate(debugSession: vscode.DebugSession) {
    this.sessionServerManager.terminate(debugSession);
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    this.sessionServerManager.dispose();
  }
}
