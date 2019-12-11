/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

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
import { NodeLauncher } from './targets/node/nodeLauncher';
import { BrowserLauncher } from './targets/browser/browserLauncher';
import { BrowserAttacher } from './targets/browser/browserAttacher';
import { ITarget } from './targets/targets';
import { DebugAdapter } from './adapter/debugAdapter';
import * as crypto from 'crypto';
import { MessageEmitterConnection, ChildConnection } from './dap/flatSessionConnection';
import { IDisposable } from './common/events';
import { SubprocessProgramLauncher } from './targets/node/subprocessProgramLauncher';
import { Contributions } from './common/contributionUtils';
import { TerminalProgramLauncher } from './targets/node/terminalProgramLauncher';
import { NodeAttacher } from './targets/node/nodeAttacher';
import { ExtensionHostLauncher } from './targets/node/extensionHostLauncher';
import { ExtensionHostAttacher } from './targets/node/extensionHostAttacher';
import { NodePathProvider } from './targets/node/nodePathProvider';

const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-js-debug-'));

class ChildSession {
  private _nameChangedSubscription: IDisposable;
  public readonly connection: ChildConnection;

  constructor(
    public readonly sessionId: string,
    connection: MessageEmitterConnection,
    target: ITarget,
  ) {
    this.connection = new ChildConnection(connection, sessionId);
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
  const pathProvider = new NodePathProvider();
  const launchers = [
    new ExtensionHostAttacher(pathProvider),
    new ExtensionHostLauncher(pathProvider),
    new NodeLauncher(pathProvider, [
      new SubprocessProgramLauncher(),
      new TerminalProgramLauncher(),
    ]),
    new NodeAttacher(pathProvider),
    new BrowserLauncher(storagePath),
    new BrowserAttacher(),
  ];

  const binderDelegate: IBinderDelegate = {
    async acquireDap(target: ITarget): Promise<DapConnection> {
      const sessionId = crypto.randomBytes(20).toString('hex');
      const config = {
        type: Contributions.ChromeDebugType,
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

      const childSession = new ChildSession(sessionId, connection, target);
      _childSessionsForTarget.set(target, childSession);
      return childSession.connection;
    },

    async initAdapter(debugAdapter: DebugAdapter, target: ITarget): Promise<boolean> {
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

  const connection = new MessageEmitterConnection();
  // First child uses no sessionId. Could potentially use something predefined that both sides know about, or have it passed with either
  // cmd line args or launch config if we decide that all sessions should definitely have an id
  const firstConnection = new ChildConnection(connection, undefined);
  new Binder(binderDelegate, firstConnection, launchers, 'targetOrigin');

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
