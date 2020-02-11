/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import 'reflect-metadata';

/**
 * This script launches the pwa adapter in "flat session" mode for DAP, which means
 * that all DAP traffic will be routed through a single connection (either tcp socket or stdin/out)
 * and use the sessionId field on each message to route it to the correct child session
 */

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Binder, IBinderDelegate } from './binder';
import DapConnection from './dap/connection';
import { ITarget } from './targets/targets';
import * as crypto from 'crypto';
import { MessageEmitterConnection, ChildConnection } from './dap/flatSessionConnection';
import { IDisposable } from './common/events';
import { DebugType } from './common/contributionUtils';
import { TargetOrigin } from './targets/targetOrigin';
import { TelemetryReporter } from './telemetry/telemetryReporter';
import { ILogger } from './common/logging';
import { createGlobalContainer, createTopLevelSessionContainer } from './ioc';

const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-js-debug-'));

class ChildSession {
  private _nameChangedSubscription: IDisposable;
  public readonly connection: ChildConnection;

  constructor(
    logger: ILogger,
    telemetry: TelemetryReporter,
    public readonly sessionId: string,
    connection: MessageEmitterConnection,
    target: ITarget,
  ) {
    this.connection = new ChildConnection(logger, telemetry, connection, sessionId);
    this._nameChangedSubscription = target.onNameChanged(() => {
      this.connection.dap().then(dap => dap.process({ name: target.name() }));
    });
  }

  dispose() {
    this.connection.dispose();
    this._nameChangedSubscription.dispose();
  }
}

function main(inputStream: NodeJS.ReadableStream, outputStream: NodeJS.WritableStream) {
  const _childSessionsForTarget = new Map<ITarget, ChildSession>();
  const telemetry = new TelemetryReporter();
  const services = createTopLevelSessionContainer(
    createGlobalContainer({ storagePath, isVsCode: false }),
  );

  const binderDelegate: IBinderDelegate = {
    async acquireDap(target: ITarget): Promise<DapConnection> {
      const sessionId = crypto.randomBytes(20).toString('hex');
      const config = {
        type: DebugType.Chrome,
        name: target.name(),
        request: 'attach',
        __pendingTargetId: target.id(),
        sessionId,
      };

      // Custom message currently not part of DAP
      connection._send({
        seq: 0,
        command: 'attachedChildSession',
        type: 'request',
        arguments: {
          config,
        },
      });

      const childSession = new ChildSession(
        services.get(ILogger),
        telemetry,
        sessionId,
        connection,
        target,
      );
      _childSessionsForTarget.set(target, childSession);
      return childSession.connection;
    },

    async initAdapter(): Promise<boolean> {
      return false;
    },

    releaseDap(target: ITarget): void {
      const childSession = _childSessionsForTarget.get(target);
      if (childSession !== undefined) {
        childSession.dispose();
      }
      _childSessionsForTarget.delete(target);
    },
  };

  const connection = new MessageEmitterConnection(telemetry, services.get(ILogger));
  // First child uses no sessionId. Could potentially use something predefined that both sides know about, or have it passed with either
  // cmd line args or launch config if we decide that all sessions should definitely have an id
  const firstConnection = new ChildConnection(
    services.get(ILogger),
    telemetry,
    connection,
    undefined,
  );
  new Binder(
    binderDelegate,
    firstConnection,
    telemetry,
    services,
    new TargetOrigin('targetOrigin'),
  );

  connection.init(inputStream, outputStream);
}

const debugServerPort = process.argv.length >= 3 ? +process.argv[2] : undefined;
if (debugServerPort !== undefined) {
  const server = net
    .createServer(async socket => {
      main(socket, socket);
    })
    .listen(debugServerPort);
  console.log(`Listening at ${(server.address() as net.AddressInfo).port}`);
} else {
  main(process.stdin, process.stdout);
}
