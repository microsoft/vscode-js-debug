/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { promises as fs } from 'fs';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { NeverCancelled } from '../../../common/cancellation';
import { Logger } from '../../../common/logging/logger';
import { delay } from '../../../common/promiseUtil';
import { findDevToolsActivePortEndpoint, getWSEndpoint } from './endpoints';

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

describe('DevToolsActivePort endpoint discovery', () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(join(tmpdir(), 'devtools-active-port-'));
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it('discovers an endpoint when the port matches', async () => {
    await fs.writeFile(
      join(userDataDir, 'DevToolsActivePort'),
      '9222\n/devtools/browser/test\n',
    );

    expect(
      await findDevToolsActivePortEndpoint('localhost', 9222, userDataDir, Logger.null),
    ).to.equal('ws://localhost:9222/devtools/browser/test');
  });

  it('ignores a file with a different port', async () => {
    await fs.writeFile(
      join(userDataDir, 'DevToolsActivePort'),
      '9223\n/devtools/browser/test\n',
    );

    expect(
      await findDevToolsActivePortEndpoint('localhost', 9222, userDataDir, Logger.null),
    ).to.be.undefined;
  });

  it('ignores a missing file', async () => {
    expect(
      await findDevToolsActivePortEndpoint('localhost', 9222, userDataDir, Logger.null),
    ).to.be.undefined;
  });

  it('handles CRLF and trailing whitespace', async () => {
    await fs.writeFile(
      join(userDataDir, 'DevToolsActivePort'),
      '9222 \r\n/devtools/browser/test \r\n',
    );

    expect(
      await findDevToolsActivePortEndpoint('localhost', 9222, userDataDir, Logger.null),
    ).to.equal('ws://localhost:9222/devtools/browser/test');
  });
});
