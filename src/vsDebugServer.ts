/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

require('source-map-support').install(); // Enable TypeScript stack traces translation
import 'reflect-metadata';

/**
 * This script launches vscode-js-debug in server mode for Visual Studio
 */
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createGlobalContainer } from './ioc';
import { IDebugSessionLike, ISessionLauncher, Session } from './sessionManager';
import { getDeferred, IDeferred } from './common/promiseUtil';
import DapConnection from './dap/connection';
import { IPseudoAttachConfiguration } from './configuration';
import { DebugConfiguration } from 'vscode';
import { ServerSessionManager } from './serverSessionManager';
import { ITarget } from './targets/targets';
import { Readable, Writable } from 'stream';
import * as nls from 'vscode-nls';

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

  constructor(inputStream?: Readable, outputStream?: Writable) {
    const services = createGlobalContainer({ storagePath, isVsCode: false });
    this.sessionServer = new ServerSessionManager(services, this);

    const deferredConnection: IDeferred<DapConnection> = getDeferred();
    const rootSession = new VSDebugSession(
      'root',
      localize('session.rootSessionName', 'JavaScript debug adapter'),
      deferredConnection.promise,
      { type: 'pwa-chrome', name: 'root', request: 'launch' },
    );
    if (inputStream && outputStream) {
      this.launchRootFromExisting(deferredConnection, rootSession, inputStream, outputStream);
    } else {
      this.launchRoot(deferredConnection, rootSession);
    }
  }

  launchRootFromExisting(
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

  launchRoot(deferredConnection: IDeferred<DapConnection>, session: VSDebugSession) {
    const result = this.sessionServer.createRootDebugServer(session, debugServerPort);
    result.connectionPromise.then(x => deferredConnection.resolve(x));
    console.log((result.server.address() as net.AddressInfo).port.toString());
  }

  launch(
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
    const result = this.sessionServer.createChildDebugServer(session);
    result.connectionPromise.then(x => deferredConnection.resolve(x));
    childAttachConfig[
      '__jsDebugChildServer'
    ] = (result.server.address() as net.AddressInfo).port.toString();

    // Custom message currently not part of DAP
    parentSession.connection._send({
      seq: 0,
      command: 'attachedChildSession',
      type: 'request',
      arguments: {
        config: childAttachConfig,
      },
    });
  }
}

const debugServerPort = process.argv.length >= 3 ? +process.argv[2] : undefined;
if (debugServerPort !== undefined) {
  const server = net
    .createServer(socket => {
      new VsDebugServer(socket, socket);
    })
    .listen(debugServerPort);

  console.log(`Listening at ${(server.address() as net.AddressInfo).port}`);
} else {
  new VsDebugServer();
}
