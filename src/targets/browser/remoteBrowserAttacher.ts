/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable, optional } from 'inversify';
import type * as vscodeType from 'vscode';
import Connection from '../../cdp/connection';
import { DebugType } from '../../common/contributionUtils';
import { ILogger } from '../../common/logging';
import { ISourcePathResolver } from '../../common/sourcePathResolver';
import { AnyChromiumAttachConfiguration, AnyLaunchConfiguration } from '../../configuration';
import { VSCodeApi } from '../../ioc-extras';
import { ILaunchContext } from '../targets';
import { BrowserAttacher } from './browserAttacher';
import { RemoteBrowserHelper } from './remoteBrowserHelper';

@injectable()
export class RemoteBrowserAttacher extends BrowserAttacher<AnyChromiumAttachConfiguration> {
  constructor(
    @inject(RemoteBrowserHelper) private readonly helper: RemoteBrowserHelper,
    @inject(ILogger) logger: ILogger,
    @inject(ISourcePathResolver) pathResolver: ISourcePathResolver,
    @optional() @inject(VSCodeApi) vscode?: typeof vscodeType,
  ) {
    super(logger, pathResolver, vscode);
  }

  /**
   * @override
   */
  protected resolveParams(
    params: AnyLaunchConfiguration,
  ): params is AnyChromiumAttachConfiguration {
    return (
      params.request === 'attach'
      && (params.type === DebugType.Chrome || params.type === DebugType.Edge)
      && params.browserAttachLocation === 'ui'
    );
  }

  /**
   * @override
   */
  protected async acquireConnectionForBrowser(
    context: ILaunchContext,
    params: AnyChromiumAttachConfiguration,
  ): Promise<Connection> {
    const transport = await this.helper.launch(context.dap, context.cancellationToken, {
      type: params.type === DebugType.Chrome ? 'chrome' : 'edge',
      params,
      attach: {
        host: params.address,
        port: params.port,
      },
    });

    return new Connection(transport, this.logger, context.telemetryReporter);
  }
}
