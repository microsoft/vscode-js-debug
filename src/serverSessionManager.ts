/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { SessionManager, ISessionLauncher, IDebugSessionLike, Session } from './sessionManager';
import { IDisposable } from './common/disposable';
import * as net from 'net';
import { Container } from 'inversify';
import { StreamDapTransport, IDapTransport } from './dap/transport';
import { IPseudoAttachConfiguration } from './configuration';
import { getDeferred, IDeferred } from './common/promiseUtil';
import DapConnection from './dap/connection';
import { Readable, Writable } from 'stream';

interface IDebugServerCreateResult {
  server: net.Server;
  connectionPromise: Promise<DapConnection>;
}

/**
 * A class for handling specifically server-based sessions in js-debug
 */
export class ServerSessionManager<T extends IDebugSessionLike> {
  private readonly sessionManager: SessionManager<T>;
  private disposables: IDisposable[] = [];
  private servers = new Map<string, net.Server>();

  constructor(globalContainer: Container, sessionLauncher: ISessionLauncher<T>) {
    this.sessionManager = new SessionManager(globalContainer, sessionLauncher);
    this.disposables.push(this.sessionManager);
  }

  /**
   * Create the appropriate debug server type from the configuration passed in the debug session
   * @param debugSession The IDE-specific debug session
   * @param debugServerPort Optional debug port to specify the listening port for the server
   */
  public createDebugServer(debugSession: T, debugServerPort?: number) {
    if ((debugSession.configuration as IPseudoAttachConfiguration).__pendingTargetId) {
      return this.createChildDebugServer(debugSession);
    } else {
      return this.createRootDebugServer(debugSession, debugServerPort);
    }
  }

  /**
   * Create a new debug server for a new root session
   * @param debugSession The IDE-specific debug session
   * @returns The newly created debug server and a promise which resolves to the DapConnection associated with the session
   */
  public createRootDebugServer(
    debugSession: T,
    debugServerPort?: number,
  ): IDebugServerCreateResult {
    return this.innerCreateServer(
      debugSession,
      transport => this.sessionManager.createNewRootSession(debugSession, transport),
      debugServerPort,
    );
  }

  /**
   * Create a new root debug session using an existing set of streams
   * @param debugSession The IDE-specific debug session
   * @param inputStream The DAP input stream
   * @param outputStream The DAP output stream
   */
  public createRootDebugSessionFromStreams(
    debugSession: T,
    inputStream: Readable,
    outputStream: Writable,
  ): Session<T> {
    const transport = new StreamDapTransport(inputStream, outputStream);
    return this.sessionManager.createNewRootSession(debugSession, transport);
  }

  /**
   * Create a new debug server for a new child session
   * @param debugSession The IDE-specific debug session
   * @returns The newly created debug server and a promise which resolves to the DapConnection associated with the session
   */
  public createChildDebugServer(debugSession: T): IDebugServerCreateResult {
    return this.innerCreateServer(debugSession, transport =>
      this.sessionManager.createNewChildSession(
        debugSession,
        (debugSession.configuration as IPseudoAttachConfiguration).__pendingTargetId,
        transport,
      ),
    );
  }

  private innerCreateServer(
    debugSession: T,
    sessionCreationFunc: (transport: IDapTransport) => Session<T>,
    debugServerPort?: number,
  ): IDebugServerCreateResult {
    const deferredConnection: IDeferred<DapConnection> = getDeferred();
    const debugServer = net.createServer(socket => {
      const transport = new StreamDapTransport(socket, socket);
      const session = sessionCreationFunc(transport);
      deferredConnection.resolve(session.connection);
    });
    debugServer.listen(debugServerPort || 0);
    this.servers.set(debugSession.id, debugServer);

    return { server: debugServer, connectionPromise: deferredConnection.promise };
  }

  /**
   * @inheritdoc
   */
  public terminate(debugSession: T) {
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
