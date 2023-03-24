/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Container } from 'inversify';
import * as vscode from 'vscode';
import { IDisposable } from '../common/events';
import { IPseudoAttachConfiguration } from '../configuration';
import { ServerSessionManager } from '../serverSessionManager';
import { ISessionLauncher, RootSession, Session } from '../sessionManager';
import { ITarget } from '../targets/targets';

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
        ...target.supplementalConfig,
        serverReadyAction: parentSession.debugSession.configuration.serverReadyAction,
        __parentId: parentSession.debugSession.id,
      } as vscode.DebugConfiguration,
      {
        parentSession: parentSession.debugSession,
        consoleMode: vscode.DebugConsoleMode.MergeWithParent,
        noDebug: parentSession.debugSession.configuration.noDebug,
        compact: parentSession instanceof RootSession, // don't compact workers/child processes
        lifecycleManagedByParent: target.independentLifeycle ? false : true,
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
  public async createDebugAdapterDescriptor(
    debugSession: vscode.DebugSession,
  ): Promise<vscode.DebugAdapterDescriptor> {
    const useLocal = process.env.JS_DEBUG_USE_LOCAL_DAP_PORT;
    if (useLocal) {
      return new vscode.DebugAdapterServer(+useLocal);
    }

    const result = await this.sessionServerManager.createDebugServer(debugSession);
    return new vscode.DebugAdapterNamedPipeServer(result.server.address() as string);
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
