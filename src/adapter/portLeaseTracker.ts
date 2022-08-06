/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import * as net from 'net';
import { CancellationToken } from 'vscode';
import * as WebSocket from 'ws';
import { cancellableRace, NeverCancelled } from '../common/cancellation';
import { IDisposable } from '../common/disposable';
import { EventEmitter } from '../common/events';
import {
  DefaultJsDebugPorts,
  findOpenPort,
  makeAcquireTcpServer,
  makeAcquireWebSocketServer,
  waitForServerToListen,
} from '../common/findOpenPort';
import { delay } from '../common/promiseUtil';
import { ExtensionLocation } from '../ioc-extras';

/**
 * Helper that creates a server registered with the lease tracker.
 */
export const acquireTrackedServer = async (
  tracker: IPortLeaseTracker,
  onSocket: (s: net.Socket) => void,
  overridePort?: number,
  host?: string,
  ct = NeverCancelled,
) => {
  const server = overridePort
    ? await waitForServerToListen(net.createServer(onSocket).listen(overridePort, host), ct)
    : await findOpenPort({ tester: makeAcquireTcpServer(onSocket, host) }, ct);
  const dispose = tracker.register((server.address() as net.AddressInfo).port);
  server.on('close', () => dispose.dispose());
  server.on('error', () => dispose.dispose());
  return server;
};

/**
 * Helper that creates a server registered with the lease tracker.
 */
export const acquireTrackedWebSocketServer = async (
  tracker: IPortLeaseTracker,
  options?: WebSocket.ServerOptions,
  ct?: CancellationToken,
) => {
  const server = await findOpenPort({ tester: makeAcquireWebSocketServer(options) }, ct);
  const dispose = tracker.register((server.address() as net.AddressInfo).port);
  server.on('close', () => dispose.dispose());
  server.on('error', () => dispose.dispose());
  return server;
};

/**
 * Tracks ports used by js-debug. All servers should be registered with the
 * tracker. This is used for incorrectly or unnecessarily forwarding ports
 * in remote scenarios.
 */
export interface IPortLeaseTracker {
  /**
   * Gets whether the extension must track its ports (at the possible expense
   * of speed).
   *
   * This is set to "true" in remote cases, which triggers a slightly slower
   * path in the bootloader.
   */
  readonly isMandated: boolean;

  /**
   * Registers a port as being in-use. Returns a Disposable that will
   * unregister the port later.
   */
  register(port: number): IDisposable;

  /**
   * Returns whether the port is registered with the lease tracker. Can wait
   * the given number of millisconds if it comes in later.
   */
  isRegistered(port: number, wait?: number): Promise<boolean>;
}

export const IPortLeaseTracker = Symbol('IPortLeaseTracker');

@injectable()
export class PortLeaseTracker implements IPortLeaseTracker {
  /**
   * @inheritdoc
   */
  public readonly isMandated: boolean;

  private readonly usedPorts = new Set<number>();
  private readonly onRegistered = new EventEmitter<number>();

  constructor(@inject(ExtensionLocation) location: ExtensionLocation) {
    this.isMandated = location === 'remote';
  }

  /**
   * @inheritdoc
   */
  register(port: number): IDisposable {
    this.usedPorts.add(port);
    this.onRegistered.fire(port);
    return { dispose: () => this.usedPorts.delete(port) };
  }

  /**
   * @inheritdoc
   */
  isRegistered(port: number, wait = 2000): Promise<boolean> {
    if (this.usedPorts.has(port)) {
      return Promise.resolve(true);
    }

    // don't wait if this port isn't in our default range
    if (port < DefaultJsDebugPorts.Min || port >= DefaultJsDebugPorts.Max) {
      return Promise.resolve(false);
    }

    return cancellableRace([
      () => delay(wait).then(() => false),
      ct =>
        new Promise<boolean>(resolve => {
          const l = this.onRegistered.event(p => {
            if (p === port) {
              resolve(true);
            }
          });
          ct.onCancellationRequested(() => l.dispose());
        }),
    ]);
  }
}
