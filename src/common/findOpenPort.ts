/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { createServer, AddressInfo } from 'net';
import { CancellationToken } from 'vscode';
import { NeverCancelled, TaskCancelledError } from './cancellation';
import { IDisposable } from './disposable';

/**
 * Finds an open TCP port that can be listened on.
 */
export async function findOpenPort(maxAttempts = 1000, ct?: CancellationToken) {
  for (let i = 0; ; i++) {
    const port = 3000 + Math.floor(Math.random() * 50000);
    try {
      await assertPortOpen(port, ct);
      return port;
    } catch (e) {
      if (i >= maxAttempts || e instanceof TaskCancelledError) {
        throw e;
      }
    }
  }
}

/**
 * Checks whether the port is open.
 */
export async function isPortOpen(port: number, ct?: CancellationToken) {
  try {
    await assertPortOpen(port, ct);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks that the port is open, throwing an error if not.
 */
export function assertPortOpen(port: number, ct: CancellationToken = NeverCancelled) {
  let disposable: IDisposable | undefined;
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(port, () => {
      const address = server.address() as AddressInfo;
      server.on('error', reject);
      server.close(() => resolve(address.port));
    });

    disposable = ct.onCancellationRequested(() => {
      server.close();
      reject(new TaskCancelledError('Port open lookup cancelled'));
    });
  }).finally(() => disposable?.dispose());
}
