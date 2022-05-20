/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { randomBytes } from 'crypto';
import { inject, injectable } from 'inversify';
import { AddressInfo } from 'net';
import { CancellationToken } from 'vscode';
import { WebSocket, WebSocketServer } from 'ws';
import { acquireTrackedWebSocketServer, IPortLeaseTracker } from '../../adapter/portLeaseTracker';
import { ITransport } from '../../cdp/transport';
import { WebSocketTransport } from '../../cdp/webSocketTransport';
import { timeoutPromise } from '../../common/cancellation';
import { IDisposable } from '../../common/disposable';
import Dap from '../../dap/api';

let launchIdCounter = 0;

@injectable()
export class RemoteBrowserHelper implements IDisposable {
  /**
   * Server we're using to wait for connections, if any.
   */
  private server?: WebSocketServer;

  /**
   * Transports to launch ID.
   */
  private teardown = new WeakMap<ITransport, () => void>();

  constructor(@inject(IPortLeaseTracker) private readonly portLeaseTracker: IPortLeaseTracker) {}

  /**
   * Launches the browser in the companion app, and return the transport.
   */
  public async launch(
    dap: Dap.Api,
    cancellationToken: CancellationToken,
    params: Omit<Dap.LaunchBrowserInCompanionEventParams, 'serverPort' | 'launchId'>,
  ): Promise<ITransport> {
    if (this.server) {
      this.server.close();
    }

    const path = `/${randomBytes(20).toString('hex')}`;
    const server = (this.server = await acquireTrackedWebSocketServer(this.portLeaseTracker, {
      perMessageDeflate: true,
      host: '127.0.0.1',
      path,
    }));

    const launchId = ++launchIdCounter;
    dap.launchBrowserInCompanion({
      ...params,
      serverPort: (server.address() as AddressInfo).port,
      path,
      launchId,
    });

    const socket = await timeoutPromise(
      new Promise<WebSocket>((resolve, reject) => {
        server.once('connection', resolve);
        server.once('error', reject);
      }),
      cancellationToken,
      'Timed out waiting for browser connection',
    );

    const transport = new WebSocketTransport(socket);
    this.teardown.set(transport, () => dap.killCompanionBrowser({ launchId }));

    return transport;
  }

  /**
   * Kills the companion associated with the given transport.
   */
  public close(transport: ITransport) {
    this.teardown.get(transport)?.();
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    this.server?.close();
    this.server = undefined;
  }
}
