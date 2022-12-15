/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

require('source-map-support').install(); // Enable TypeScript stack traces translation
import * as fs from 'fs';
/**
 * This script launches vscode-js-debug in server mode for Visual Studio
 */
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import 'reflect-metadata';
import { Readable, Writable } from 'stream';
import { DebugConfiguration } from 'vscode';
import * as nls from 'vscode-nls';
import { DebugType } from './common/contributionUtils';
import { getDeferred, IDeferred } from './common/promiseUtil';
import { IPseudoAttachConfiguration } from './configuration';
import DapConnection from './dap/connection';
import { createGlobalContainer } from './ioc';
import { ServerSessionManager } from './serverSessionManager';
import { IDebugSessionLike, ISessionLauncher, Session } from './sessionManager';
import { ITarget } from './targets/targets';

const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-js-debug-'));

const localize = nls.loadMessageBundle();

class VSDebugSession implements IDebugSessionLike {
  constructor(
    public id: string,
    name: string,
    private readonly childConnection: Promise<DapConnection>,
    public readonly configuration: DebugConfiguration,
  ) {
    this._name = name;
  }

  private _name: string;
  set name(newName: string) {
    this._name = newName;
    this.childConnection
      .then(conn => conn.initializedBlocker)
      .then(conn => conn.dap())
      .then(dap => {
        dap.process({ name: newName });
      });
  }
  get name() {
    return this._name;
  }
}

class VsDebugServer implements ISessionLauncher<VSDebugSession> {
  private readonly sessionServer: ServerSessionManager<VSDebugSession>;

  constructor(host?: string, inputStream?: Readable, outputStream?: Writable) {
    const services = createGlobalContainer({ storagePath, isVsCode: false });
    this.sessionServer = new ServerSessionManager(services, this, host);

    const deferredConnection: IDeferred<DapConnection> = getDeferred();
    const rootSession = new VSDebugSession(
      'root',
      localize('session.rootSessionName', 'JavaScript debug adapter'),
      deferredConnection.promise,
      { type: DebugType.Chrome, name: 'root', request: 'launch' },
    );
    if (inputStream && outputStream) {
      this.launchRootFromExisting(deferredConnection, rootSession, inputStream, outputStream);
    } else {
      this.launchRoot(deferredConnection, rootSession);
    }
  }

  private launchRootFromExisting(
    deferredConnection: IDeferred<DapConnection>,
    session: VSDebugSession,
    inputStream: Readable,
    outputStream: Writable,
  ) {
    const newSession = this.sessionServer.createRootDebugSessionFromStreams(
      session,
      inputStream,
      outputStream,
    );
    deferredConnection.resolve(newSession.connection);
  }

  private async launchRoot(deferredConnection: IDeferred<DapConnection>, session: VSDebugSession) {
    const result = await this.sessionServer.createRootDebugServer(session, debugServerPort);
    result.connectionPromise.then(x => deferredConnection.resolve(x));
    console.log((result.server.address() as net.AddressInfo).port.toString());
  }

  public launch(
    parentSession: Session<VSDebugSession>,
    target: ITarget,
    config: IPseudoAttachConfiguration,
  ): void {
    const childAttachConfig = { ...config, sessionId: target.id, __jsDebugChildServer: '' };
    const deferredConnection: IDeferred<DapConnection> = getDeferred();
    const session = new VSDebugSession(
      target.id(),
      target.name(),
      deferredConnection.promise,
      childAttachConfig,
    );

    this.sessionServer.createChildDebugServer(session).then(({ server, connectionPromise }) => {
      connectionPromise.then(x => deferredConnection.resolve(x));
      childAttachConfig.__jsDebugChildServer = (
        server.address() as net.AddressInfo
      ).port.toString();

      // Custom message currently not part of DAP
      parentSession.connection._send({
        seq: 0,
        command: 'attachedChildSession',
        type: 'request',
        arguments: {
          config: childAttachConfig,
        },
      });
    });
  }
}

let debugServerPort: number | undefined = undefined;
let debugServerHost: string | undefined = undefined;

if (process.argv.length >= 3) {
  debugServerPort = +process.argv[2];
  if (process.argv.length >= 4) {
    debugServerHost = process.argv[3];
  }
}

if (debugServerPort !== undefined) {
  const server = net
    .createServer(socket => {
      new VsDebugServer(debugServerHost, socket, socket);
    })
    .listen(debugServerPort, debugServerHost);

  server.on('listening', () => {
    console.log(
      `Listening at ${(server.address() as net.AddressInfo).address}:${
        (server.address() as net.AddressInfo).port
      }`,
    );
  });
} else {
  new VsDebugServer(debugServerHost);
}
