/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import { createConnection, Socket } from 'net';
import type * as vscodeType from 'vscode';
import Connection from '../../cdp/connection';
import { RawPipeTransport } from '../../cdp/rawPipeTransport';
import { DebugType } from '../../common/contributionUtils';
import { DisposableList } from '../../common/disposable';
import { ILogger, LogTag } from '../../common/logging';
import { ISourcePathResolver } from '../../common/sourcePathResolver';
import { createTargetFilterForConfig, TargetFilter } from '../../common/urlUtils';
import {
  AnyLaunchConfiguration,
  applyDefaults,
  IChromeAttachConfiguration,
} from '../../configuration';
import { ITelemetryReporter } from '../../telemetry/telemetryReporter';
import { SourcePathResolverFactory } from '../sourcePathResolverFactory';
import { ILaunchContext } from '../targets';
import { BrowserAttacher } from './browserAttacher';
import { BrowserTargetManager } from './browserTargetManager';
import { BrowserTargetType } from './browserTargets';
import { VSCodeRendererTargetManager } from './vscodeRendererTargetManager';

export interface IRendererAttachParams extends IChromeAttachConfiguration {
  __sessionId: string;
  debugWebviews: boolean;
  debugWebWorkerExtHost: boolean;
}

@injectable()
export class VSCodeRendererAttacher extends BrowserAttacher<IRendererAttachParams> {
  /**
   * Map of debug IDs to ports the renderer is listening on,
   * set from the {@see ExtensionHostLauncher}.
   */
  public static readonly debugIdToRendererDebugPort = new Map<string, number>();

  constructor(
    @inject(ILogger) logger: ILogger,
    @inject(ISourcePathResolver) pathResolver: ISourcePathResolver,
    @inject(SourcePathResolverFactory)
    private readonly pathResolverFactory: SourcePathResolverFactory,
  ) {
    super(logger, pathResolver);
  }

  /**
   * @override
   */
  public async launch(params: AnyLaunchConfiguration, context: ILaunchContext) {
    if (params.type !== DebugType.ExtensionHost || params.request !== 'attach') {
      return { blockSessionTermination: false };
    }

    const rendererPort = VSCodeRendererAttacher.debugIdToRendererDebugPort.get(params.__sessionId);
    if (!rendererPort) {
      return { blockSessionTermination: false };
    }

    const configuration = applyDefaults({
      name: 'Webview',
      type: DebugType.Chrome,
      request: 'attach',
      port: rendererPort,
      __workspaceFolder: params.__workspaceFolder,
      urlFilter: '',
      ...params.rendererDebugOptions,
    }) as IRendererAttachParams;

    configuration.__sessionId = params.__sessionId;
    configuration.debugWebWorkerExtHost = params.debugWebWorkerHost;
    configuration.debugWebviews = params.debugWebviews;

    super
      .launch(configuration, context)
      .catch(err => this.logger.error(LogTag.RuntimeException, 'Error in webview attach', { err }));

    return { blockSessionTermination: false };
  }

  /**
   * @override
   */
  protected async acquireConnectionInner(
    telemetryReporter: ITelemetryReporter,
    params: IRendererAttachParams,
    cancellationToken: vscodeType.CancellationToken,
  ) {
    const disposable = new DisposableList();
    const pipe = await new Promise<Socket>((resolve, reject) => {
      const p: Socket = createConnection({ port: params.port }, () => resolve(p));
      p.on('error', reject);

      disposable.push(
        cancellationToken.onCancellationRequested(() => {
          p.destroy();
          reject(new Error('connection timed out'));
        }),
      );
    }).finally(() => disposable.dispose());

    return new Connection(new RawPipeTransport(this.logger, pipe), this.logger, telemetryReporter);
  }

  protected async getTargetFilter(
    _manager: BrowserTargetManager,
    params: IRendererAttachParams,
  ): Promise<TargetFilter> {
    const baseFilter = createTargetFilterForConfig(params);
    return target => {
      if (
        params.debugWebWorkerExtHost &&
        target.type === BrowserTargetType.Worker &&
        target.title === 'WorkerExtensionHost'
      ) {
        return true;
      }

      if (params.debugWebviews && target.type === BrowserTargetType.IFrame && baseFilter(target)) {
        return true;
      }

      return false;
    };
  }

  /**
   * @override
   */
  protected async createTargetManager(
    connection: Connection,
    params: IRendererAttachParams,
    context: ILaunchContext,
  ) {
    return new VSCodeRendererTargetManager(
      connection,
      undefined,
      connection.rootSession(),
      this.pathResolverFactory.create(params),
      this.logger,
      context.telemetryReporter,
      params,
      context.targetOrigin,
    );
  }
}
