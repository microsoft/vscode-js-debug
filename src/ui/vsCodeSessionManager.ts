/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as net from 'net';
import * as vscode from 'vscode';
import { IDisposable } from '../common/events';
import { Container } from 'inversify';
import { SessionManager, SessionLauncher } from '../sessionManager';
import { StreamDapTransport } from '../dap/transport';

/**
 * Session launcher which uses vscode's `startDebugging` method to start a new debug session
 * @param parentSession The parent debug session to pass to `startDebugging`
 * @param config Launch configuration for the new debug session
 */
const vsCodeSessionLauncher: SessionLauncher<vscode.DebugSession> = (parentSession, _, config) => {
  vscode.debug.startDebugging(
    parentSession.debugSession.workspaceFolder,
    config as vscode.DebugConfiguration,
    {
      parentSession: parentSession.debugSession,
      consoleMode: vscode.DebugConsoleMode.MergeWithParent,
    },
  );
};

/**
 * VS Code specific session manager which also implements the DebugAdapterDescriptorFactory
 * interface
 */
export class VSCodeSessionManager implements vscode.DebugAdapterDescriptorFactory, IDisposable {
  private readonly sessionManager: SessionManager<vscode.DebugSession>;
  private disposables: IDisposable[] = [];
  private servers = new Map<string, net.Server>();

  constructor(globalContainer: Container) {
    this.sessionManager = new SessionManager(globalContainer, vsCodeSessionLauncher);
    this.disposables.push(this.sessionManager);
  }

  /**
   * @inheritdoc
   */
  public createDebugAdapterDescriptor(
    debugSession: vscode.DebugSession,
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    debugSession.workspaceFolder;

    const debugServer = net.createServer(socket => {
      const transport = new StreamDapTransport(socket, socket);
      this.sessionManager.createNewSession(debugSession, debugSession.configuration, transport);
    });
    debugServer.listen(0);
    this.servers.set(debugSession.id, debugServer);

    return new vscode.DebugAdapterServer((debugServer.address() as net.AddressInfo).port);
  }

  /**
   * @inheritdoc
   */
  public terminate(debugSession: vscode.DebugSession) {
    this.sessionManager.terminate(debugSession);
    this.servers.get(debugSession.id)?.close();
    this.servers.delete(debugSession.id);
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    this.disposables.forEach(d => d.dispose());
  }
}
