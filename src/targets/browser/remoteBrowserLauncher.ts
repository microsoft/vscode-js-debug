/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable } from 'inversify';
import { AnyLaunchConfiguration, AnyChromiumLaunchConfiguration } from '../../configuration';
import { BrowserLauncher } from './browserLauncher';
import { DebugType } from '../../common/contributionUtils';
import Dap from '../../dap/api';
import { CancellationToken } from 'vscode';
import { ITelemetryReporter } from '../../telemetry/telemetryReporter';
import { createServer, Socket, Server, AddressInfo } from 'net';
import { getDeferred } from '../../common/promiseUtil';
import Connection from '../../cdp/connection';
import { timeoutPromise } from '../../common/cancellation';
import { ILaunchResult, defaultArgs } from './launcher';
import { EventEmitter } from '../../common/events';
import { BrowserArgs } from './browserArgs';
import { GzipPipeTransport } from '../../cdp/gzipPipeTransport';

@injectable()
export class RemoteBrowserLauncher extends BrowserLauncher<AnyChromiumLaunchConfiguration> {
  private static launchId = 0;

  /**
   * Server we're using to wait for connections, if any.
   */
  private server?: Server;

  /**
   * @inheritdoc
   */
  protected resolveParams(params: AnyLaunchConfiguration) {
    return (params.type === DebugType.Chrome || params.type === DebugType.Edge) &&
      params.request === 'launch' &&
      params.browserLaunchLocation === 'ui'
      ? params
      : undefined;
  }

  /**
   * @override
   */
  protected async launchBrowser(
    params: AnyChromiumLaunchConfiguration,
    dap: Dap.Api,
    cancellationToken: CancellationToken,
    telemetryReporter: ITelemetryReporter,
  ): Promise<ILaunchResult> {
    if (this.server) {
      this.server.close();
    }

    const connection = getDeferred<Socket>();
    const server = (this.server = await new Promise<Server>((resolve, reject) => {
      const s = createServer(connection.resolve)
        .on('error', reject)
        .listen(0, '127.0.0.1', () => resolve(s));
    }));

    const launchId = RemoteBrowserLauncher.launchId++;
    dap.launchBrowserInCompanion({
      type: params.type === DebugType.Chrome ? 'chrome' : 'edge',
      serverPort: (server.address() as AddressInfo).port,
      browserArgs: defaultArgs(new BrowserArgs(params.runtimeArgs || []), {
        hasUserNavigation: !!params.url,
        ignoreDefaultArgs: !params.includeDefaultArgs,
      }).toArray(),
      launchId,
      params,
    });

    const socket = await timeoutPromise(
      connection.promise,
      cancellationToken,
      'Timed out waiting for browser connection',
    );

    const logger = this.logger;
    const transport = new GzipPipeTransport(logger, socket);
    return {
      cdp: new Connection(transport, logger, telemetryReporter),
      process: {
        onExit: new EventEmitter<number>().event,
        onError: new EventEmitter<Error>().event,
        transport: () => Promise.resolve(transport),
        kill: () => dap.killCompanionBrowser({ launchId }),
      },
    };
  }

  public dispose() {
    super.dispose();
    this.server?.close();
  }

  /**
   * @inheritdoc
   */
  protected async findBrowserPath(): Promise<string> {
    throw new Error('not implemented');
  }
}
