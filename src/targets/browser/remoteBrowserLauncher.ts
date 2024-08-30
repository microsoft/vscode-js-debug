/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import { CancellationToken } from 'vscode';
import Connection from '../../cdp/connection';
import { DebugType } from '../../common/contributionUtils';
import { EventEmitter } from '../../common/events';
import { ILogger } from '../../common/logging';
import { ISourcePathResolver } from '../../common/sourcePathResolver';
import { AnyChromiumLaunchConfiguration, AnyLaunchConfiguration } from '../../configuration';
import Dap from '../../dap/api';
import { FS, FsPromises, IInitializeParams, StoragePath } from '../../ioc-extras';
import { ITelemetryReporter } from '../../telemetry/telemetryReporter';
import { BrowserArgs } from './browserArgs';
import { BrowserLauncher } from './browserLauncher';
import { defaultArgs, ILaunchResult } from './launcher';
import { RemoteBrowserHelper } from './remoteBrowserHelper';

@injectable()
export class RemoteBrowserLauncher extends BrowserLauncher<AnyChromiumLaunchConfiguration> {
  constructor(
    @inject(StoragePath) storagePath: string,
    @inject(ILogger) logger: ILogger,
    @inject(ISourcePathResolver) pathResolver: ISourcePathResolver,
    @inject(IInitializeParams) initializeParams: Dap.InitializeParams,
    @inject(FS) fs: FsPromises,
    @inject(RemoteBrowserHelper) private readonly helper: RemoteBrowserHelper,
  ) {
    super(storagePath, logger, pathResolver, initializeParams, fs);
  }

  /**
   * @inheritdoc
   */
  protected resolveParams(params: AnyLaunchConfiguration) {
    return (params.type === DebugType.Chrome || params.type === DebugType.Edge)
        && params.request === 'launch'
        && params.browserLaunchLocation === 'ui'
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
    const transport = await this.helper.launch(dap, cancellationToken, {
      type: params.type === DebugType.Chrome ? 'chrome' : 'edge',
      browserArgs: defaultArgs(new BrowserArgs(params.runtimeArgs || []), {
        hasUserNavigation: !!params.url,
        ignoreDefaultArgs: !params.includeDefaultArgs,
      })
        .setConnection(params.port || 'pipe')
        .toArray(),
      params,
    });

    return {
      canReconnect: false,
      createConnection: () =>
        Promise.resolve(new Connection(transport, this.logger, telemetryReporter)),
      process: {
        onExit: new EventEmitter<number>().event,
        onError: new EventEmitter<Error>().event,
        transport: () => Promise.resolve(transport),
        kill: () => this.helper.close(transport),
      },
    };
  }

  /**
   * @inheritdoc
   */
  protected async findBrowserPath(): Promise<string> {
    throw new Error('not implemented');
  }
}
