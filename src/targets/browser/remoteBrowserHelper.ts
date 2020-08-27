/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import { AddressInfo, createServer, Server, Socket } from 'net';
import { CancellationToken } from 'vscode';
import { GzipPipeTransport } from '../../cdp/gzipPipeTransport';
import { ITransport } from '../../cdp/transport';
import { timeoutPromise } from '../../common/cancellation';
import { IDisposable } from '../../common/disposable';
import { ILogger } from '../../common/logging';
import { getDeferred } from '../../common/promiseUtil';
import Dap from '../../dap/api';

let launchIdCounter = 0;

@injectable()
export class RemoteBrowserHelper implements IDisposable {
  /**
   * Server we're using to wait for connections, if any.
   */
  private server?: Server;

  /**
   * Transports to launch ID.
   */
  private teardown = new WeakMap<ITransport, () => void>();

  constructor(@inject(ILogger) private readonly logger: ILogger) {}

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

    const connection = getDeferred<Socket>();
    const server = (this.server = await new Promise<Server>((resolve, reject) => {
      const s = createServer(connection.resolve)
        .on('error', reject)
        .listen(0, '127.0.0.1', () => resolve(s));
    }));

    const launchId = ++launchIdCounter;
    dap.launchBrowserInCompanion({
      ...params,
      serverPort: (server.address() as AddressInfo).port,
      launchId,
    });

    const socket = await timeoutPromise(
      connection.promise,
      cancellationToken,
      'Timed out waiting for browser connection',
    );

    const transport = new GzipPipeTransport(this.logger, socket);
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
