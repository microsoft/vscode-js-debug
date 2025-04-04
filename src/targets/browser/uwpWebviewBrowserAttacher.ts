/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable, optional } from 'inversify';
import { connect, Socket } from 'net';
import { join } from 'path';
import type * as vscodeType from 'vscode';
import Connection from '../../cdp/connection';
import { RawPipeTransport } from '../../cdp/rawPipeTransport';
import { timeoutPromise } from '../../common/cancellation';
import { DebugType } from '../../common/contributionUtils';
import { ILogger } from '../../common/logging';
import { some } from '../../common/promiseUtil';
import { ISourcePathResolver } from '../../common/sourcePathResolver';
import { getWinUtils } from '../../common/win32Utils';
import { AnyLaunchConfiguration, IEdgeAttachConfiguration } from '../../configuration';
import { noUwpPipeFound, uwpPipeNotAvailable } from '../../dap/errors';
import { ProtocolError } from '../../dap/protocolError';
import { VSCodeApi } from '../../ioc-extras';
import { ILaunchContext } from '../targets';
import { BrowserAttacher } from './browserAttacher';

type IEdgeParamsWithWebviewPipe = Omit<IEdgeAttachConfiguration, 'useWebView'> & {
  useWebView: { pipeName: string };
};

@injectable()
export class UWPWebviewBrowserAttacher extends BrowserAttacher<IEdgeParamsWithWebviewPipe> {
  constructor(
    @inject(ILogger) logger: ILogger,
    @inject(ISourcePathResolver) pathResolver: ISourcePathResolver,
    @optional() @inject(VSCodeApi) vscode?: typeof vscodeType,
  ) {
    super(logger, pathResolver, vscode);
  }

  /**
   * @override
   */
  protected resolveParams(params: AnyLaunchConfiguration): params is IEdgeParamsWithWebviewPipe {
    return (
      params.request === 'attach'
      && params.type === DebugType.Edge
      && typeof params.useWebView === 'object'
    );
  }

  /**
   * @override
   */
  protected async acquireConnectionForBrowser(
    context: ILaunchContext,
    params: IEdgeParamsWithWebviewPipe,
  ): Promise<Connection> {
    const { getAppContainerProcessTokens } = await getWinUtils();
    const pipeNames = getAppContainerProcessTokens().map(n => join(n, params.useWebView.pipeName));
    if (!pipeNames) {
      throw new ProtocolError(uwpPipeNotAvailable());
    }

    const pipes = pipeNames.map(name => connect(name));
    let succeeded: Socket | undefined;
    try {
      succeeded = await timeoutPromise(
        some(
          pipes.map(
            pipe =>
              new Promise<Socket | undefined>(resolve =>
                pipe.on('error', () => resolve(undefined)).on('connect', () => resolve(pipe))
              ),
          ),
        ),
        context.cancellationToken,
      );
    } finally {
      for (const pipe of pipes) {
        if (pipe !== succeeded) {
          pipe.destroy();
        }
      }
    }

    if (!succeeded) {
      throw new ProtocolError(noUwpPipeFound());
    }

    const transport = new RawPipeTransport(this.logger, succeeded);
    return new Connection(transport, this.logger, context.telemetryReporter);
  }
}
