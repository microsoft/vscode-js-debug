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
  public server?: net.Server;
  private deferredConnection: IDeferred<DapConnection>;

  constructor() {
    this.deferredConnection = getDeferred();
  }

  init(telemetryReporter: TelemetryReporter, logger: ILogger) {
    this.server = net
      .createServer(async socket => {
        this.getConnection().then(conn => conn.init(socket, socket));
      })
      .listen(0);

    this.deferredConnection.resolve(new DapConnection(telemetryReporter, logger));
  }

  getConnection() {
    return this.deferredConnection.promise;
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

  constructor(globalContainer: Container) {
    this.sessionManager = new SessionManager(globalContainer, vsCodeSessionLauncher);
  }

  /**
   * @inheritdoc
   */
  public createDebugAdapterDescriptor(
    debugSession: vscode.DebugSession,
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    debugSession.workspaceFolder;
    const connectionStrat = new SocketServerConnectionStrategy();
    this.sessionManager.createNewSession(debugSession, debugSession.configuration, connectionStrat);
    return new vscode.DebugAdapterServer(
      (connectionStrat.server!.address() as net.AddressInfo).port,
    );
  }

  /**
   * @inheritdoc
   */
  public terminate(debugSession: vscode.DebugSession) {
    this.sessionManager.terminate(debugSession);
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    this.sessionManager.dispose();
  }
}
