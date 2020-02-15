/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as net from 'net';
import * as vscode from 'vscode';
import DapConnection from '../dap/connection';
import { IDisposable } from '../common/events';
import { TelemetryReporter } from '../telemetry/telemetryReporter';
import { ILogger } from '../common/logging';
import { Container } from 'inversify';
import { SessionManager, IConnectionStrategy, SessionLauncher } from '../sessionManager';
import { IDeferred, getDeferred } from '../common/promiseUtil';

/**
 * A connection strategy which creates a new TCP socket server for every new connection
 */
class SocketServerConnectionStrategy implements IConnectionStrategy {
  private deferredConnection: IDeferred<DapConnection>;

  constructor(server: net.Server) {
    this.deferredConnection = getDeferred();
    server.on('connection', socket => {
      this.deferredConnection.promise.then(conn => conn.init(socket, socket));
    });
  }

  getConnection(telemetryReporter: TelemetryReporter, logger: ILogger) {
    const newConnection = new DapConnection(telemetryReporter, logger);
    this.deferredConnection.resolve(newConnection);
    return newConnection;
  }
}

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

    const debugServer = net.createServer().listen(0);
    this.servers.set(debugSession.id, debugServer);
    const connectionStrat = new SocketServerConnectionStrategy(debugServer);
    this.sessionManager.createNewSession(debugSession, debugSession.configuration, connectionStrat);
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
