/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { createServer, AddressInfo } from 'net';

/**
 * Finds an open TCP port that can be listened on.
 */
export async function findOpenPort(maxAttempts = 1000) {
  for (let i = 0; ; i++) {
    const port = 3000 + Math.floor(Math.random() * 50000);
    try {
      await assertPortOpen(port);
      return port;
    } catch (e) {
      if (i >= maxAttempts) {
        throw e;
      }
    }
  }
}

export function assertPortOpen(port: number) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(port, () => {
      const address = server.address() as AddressInfo;
      server.on('error', reject);
      server.close(() => resolve(address.port));
    });
  });
}
