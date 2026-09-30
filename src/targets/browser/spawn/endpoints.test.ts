/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import { NeverCancelled } from '../../../common/cancellation';
import { Logger } from '../../../common/logging/logger';
import { delay } from '../../../common/promiseUtil';
import { getWSEndpoint } from './endpoints';

describe('endpoint discovery', () => {
  it('discovers an IPv4 only target through localhost without request errors', async function() {
    this.timeout(5000);

    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        request.url === '/json/list'
          ? JSON.stringify([{ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/target` }])
          : JSON.stringify({}),
      );
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const port = (server.address() as AddressInfo).port;
    try {
      expect(
        await getWSEndpoint(
          `http://localhost:${port}`,
          NeverCancelled,
          Logger.null,
          true,
        ),
      ).to.equal(`ws://127.0.0.1:${port}/target`);

      // A cancelled failed probe used to surface a retry error after discovery succeeded.
      await delay(1500);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
    }
  });
});
