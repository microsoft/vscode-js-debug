/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable, inject } from 'inversify';
import { BrowserAttacher } from './browserAttacher';
import {
  applyDefaults,
  IChromeAttachConfiguration,
  AnyLaunchConfiguration,
  AnyChromiumAttachConfiguration,
} from '../../configuration';
import { DebugType } from '../../common/contributionUtils';
import type * as vscodeType from 'vscode';
import { ILaunchContext } from '../targets';
import { createConnection, Socket } from 'net';
import { ITelemetryReporter } from '../../telemetry/telemetryReporter';
import { RawPipeTransport } from '../../cdp/rawPipeTransport';
import Connection from '../../cdp/connection';
import { SourcePathResolverFactory } from '../sourcePathResolverFactory';
import { ILogger } from '../../common/logging';
import { ISourcePathResolver } from '../../common/sourcePathResolver';
import { BrowserTargetManager, BrowserTargetType, BrowserTarget } from './browserTargets';
import { DisposableList } from '../../common/disposable';
import { TargetFilter, createTargetFilterForConfig } from '../../common/urlUtils';
import { URL } from 'url';

export const enum WebviewContentPurpose {
  NotebookRenderer = 'notebookRenderer',
  CustomEditor = 'customEditor',
}

@injectable()
export class WebviewAttacher extends BrowserAttacher {
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

    const rendererPort = WebviewAttacher.debugIdToRendererDebugPort.get(params.__sessionId);
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
      ...(typeof params.debugWebviews === 'object' ? params.debugWebviews : {}),
    }) as IChromeAttachConfiguration;

    return super.launch(configuration, context);
  }

  /**
   * @override
   */
  protected async acquireConnectionInner(
    telemetryReporter: ITelemetryReporter,
    params: AnyChromiumAttachConfiguration,
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
    params: AnyChromiumAttachConfiguration,
  ): Promise<TargetFilter> {
    const baseFilter = createTargetFilterForConfig(params);
    return target => target.type === BrowserTargetType.IFrame && baseFilter(target);
  }

  /**
   * @override
   */
  protected async createTargetManager(
    connection: Connection,
    params: AnyChromiumAttachConfiguration,
    context: ILaunchContext,
  ) {
    const manager = new BrowserTargetManager(
      connection,
      undefined,
      connection.rootSession(),
      this.pathResolverFactory.create(params),
      this.logger,
      context.telemetryReporter,
      params,
      context.targetOrigin,
    );

    manager.onTargetAdded(target => {
      if (target.type() === BrowserTargetType.IFrame) {
        target.setComputeNameFn(this.computeName);
      }
    });

    return manager;
  }

  private readonly computeName = (target: BrowserTarget) => {
    let url: URL;
    try {
      url = new URL(target.targetInfo.url);
    } catch {
      return;
    }

    switch (url.searchParams.get('purpose')) {
      case WebviewContentPurpose.CustomEditor:
        return `${url.searchParams.get('extensionId')} editor: ${url.host}`;
      case WebviewContentPurpose.NotebookRenderer:
        return `Notebook Renderer: ${url.host}`;
      default:
        const extensionId = url.searchParams.get('extensionId');
        return `Webview: ${extensionId ? extensionId + ' ' : ''} ${url.host}`;
    }
  };
}
