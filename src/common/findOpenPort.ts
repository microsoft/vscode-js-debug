/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as net from 'net';
import type { CancellationToken } from 'vscode';
import * as WebSocket from 'ws';
import { NeverCancelled, TaskCancelledError } from './cancellation';
import { IDisposable } from './disposable';
import { randomInRange } from './random';

type PortTesterFn<T> = (port: number, ct: CancellationToken) => Promise<T>;

export interface IFindOpenPortOptions<T> {
  min?: number;
  max?: number;
  attempts?: number;
  tester: PortTesterFn<T>;
}

export const enum DefaultJsDebugPorts {
  Min = 53000,
  Max = 54000,
}

/**
 * Finds an open TCP port that can be listened on. If a custom tester is
 * provided, its return value is used. Otherwise, just a number is returned.
 */
export function findOpenPort(
  options?: Partial<IFindOpenPortOptions<number>>,
  cancellationToken?: CancellationToken,
): Promise<number>;
export function findOpenPort<T>(
  options: Partial<IFindOpenPortOptions<T>>,
  cancellationToken?: CancellationToken,
): Promise<T>;
export async function findOpenPort<T>(
  {
    min = DefaultJsDebugPorts.Min,
    max = DefaultJsDebugPorts.Max,
    attempts = 1000,
    tester = acquirePortNumber as PortTesterFn<T>,
  }: Partial<IFindOpenPortOptions<T>> = {},
  cancellationToken: CancellationToken = NeverCancelled,
) {
  let port = randomInRange(min, max);
  for (let i = Math.min(attempts, max - min);; i--) {
    try {
      return await tester(port, cancellationToken);
    } catch (e) {
      if (i === 0 || e instanceof TaskCancelledError) {
        throw e;
      } else {
        port = port === max - 1 ? min : port + 1;
      }
    }
  }
}

/**
 * Checks whether the port is open.
 */
export async function isPortOpen(port: number, ct?: CancellationToken) {
  try {
    await acquirePortNumber(port, ct);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks that the port is open, throwing an error if not.
 * @returns the port number
 */
export function acquirePortNumber(port: number, ct: CancellationToken = NeverCancelled) {
  let disposable: IDisposable | undefined;
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(port, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      server.close(() => resolve(address.port));
    });

    server.on('error', reject);

    disposable = ct.onCancellationRequested(() => {
      server.close();
      reject(new TaskCancelledError('Port open lookup cancelled'));
    });
  }).finally(() => disposable?.dispose());
}

/**
 * Tester that can be passed into findOpenPort to create a TCP server.
 * @returns the listening server
 */
export const makeAcquireTcpServer =
  (onSocket: (socket: net.Socket) => void, host?: string): PortTesterFn<net.Server> =>
  (
    port,
    ct,
  ) => {
    const server = net.createServer(onSocket);
    server.listen(port, host);
    return waitForServerToListen(server, ct);
  };

/**
 * Tester that can be passed into findOpenPort to create a WebSocket server.
 * @returns the listening server
 */
export const makeAcquireWebSocketServer =
  (options?: WebSocket.ServerOptions): PortTesterFn<WebSocket.Server> => (port, ct) =>
    waitForServerToListen(
      new WebSocket.WebSocketServer({ host: '127.0.0.1', ...options, port }),
      ct,
    );

interface IServerLike {
  on(event: 'error', handler: (err: Error) => void): void;
  on(event: 'listening', handler: () => void): void;
  close(): void;
}

export const waitForServerToListen = <T extends IServerLike>(
  server: T,
  ct: CancellationToken,
): Promise<T> => {
  let disposable: IDisposable | undefined;
  return new Promise<T>((resolve, reject) => {
    server.on('error', reject);
    server.on('listening', () => resolve(server));

    disposable = ct.onCancellationRequested(() => {
      server.close();
      reject(new TaskCancelledError('Port open lookup cancelled'));
    });
  }).finally(() => disposable?.dispose());
};
