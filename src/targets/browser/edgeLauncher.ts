/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IBrowserFinder } from '@vscode/js-debug-browsers';
import { randomBytes } from 'crypto';
import { inject, injectable, tagged } from 'inversify';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { CancellationToken } from 'vscode';
import CdpConnection from '../../cdp/connection';
import { WebSocketTransport } from '../../cdp/webSocketTransport';
import { NeverCancelled } from '../../common/cancellation';
import { DebugType } from '../../common/contributionUtils';
import { canAccess } from '../../common/fsUtils';
import { ILogger } from '../../common/logging';
import { getDeferred } from '../../common/promiseUtil';
import { ISourcePathResolver } from '../../common/sourcePathResolver';
import { createTargetFilterForConfig, requirePageTarget } from '../../common/urlUtils';
import { AnyLaunchConfiguration, IEdgeLaunchConfiguration } from '../../configuration';
import Dap from '../../dap/api';
import { browserNotFound } from '../../dap/errors';
import { ProtocolError } from '../../dap/protocolError';
import { BrowserFinder, FS, FsPromises, IInitializeParams, StoragePath } from '../../ioc-extras';
import { ITelemetryReporter } from '../../telemetry/telemetryReporter';
import { IWebViewConnectionInfo } from '../targets';
import { BrowserLauncher } from './browserLauncher';

const defaultEdgeFlags = ['--do-not-de-elevate'];

@injectable()
export class EdgeLauncher extends BrowserLauncher<IEdgeLaunchConfiguration> {
  constructor(
    @inject(StoragePath) storagePath: string,
    @inject(ILogger) logger: ILogger,
    @inject(BrowserFinder)
    @tagged('browser', 'edge')
    protected readonly browserFinder: IBrowserFinder,
    @inject(FS) fs: FsPromises,
    @inject(ISourcePathResolver) pathResolver: ISourcePathResolver,
    @inject(IInitializeParams) initializeParams: Dap.InitializeParams,
  ) {
    super(storagePath, logger, pathResolver, initializeParams, fs);
  }

  /**
   * @inheritdoc
   */
  protected resolveParams(params: AnyLaunchConfiguration) {
    return params.type === DebugType.Edge
        && params.request === 'launch'
        && params.browserLaunchLocation === 'workspace'
      ? params
      : undefined;
  }

  /**
   * @override
   */
  protected launchBrowser(
    params: IEdgeLaunchConfiguration,
    dap: Dap.Api,
    cancellationToken: CancellationToken,
    telemetryReporter: ITelemetryReporter,
  ) {
    return super.launchBrowser(
      {
        ...params,
        runtimeArgs: params.runtimeArgs ?? defaultEdgeFlags,
      },
      dap,
      cancellationToken,
      telemetryReporter,
      params.useWebView ? this.getWebviewPort(params, telemetryReporter) : undefined,
    );
  }

  /**
   * If there's a urlFilter specifies for Edge webviews, use that and ignore
   * `about:blank`. It seems that webview2 always briefly navigates to
   * `about:blank`, which would cause us to attach to all webviews even when
   * we don't want to.
   * @override
   */
  protected getFilterForTarget(params: IEdgeLaunchConfiguration) {
    return params.useWebView && params.urlFilter
      ? requirePageTarget(createTargetFilterForConfig(params))
      : super.getFilterForTarget(params);
  }

  /**
   * Gets the port number we should connect to to debug webviews in the target.
   */
  private async getWebviewPort(
    params: IEdgeLaunchConfiguration,
    telemetryReporter: ITelemetryReporter,
  ): Promise<number> {
    const promisedPort = getDeferred<number>();

    if (!params.runtimeExecutable) {
      // runtimeExecutable is required for web view debugging.
      promisedPort.resolve(params.port);
      return promisedPort.promise;
    }

    const exeName = params.runtimeExecutable.split(/\\|\//).pop();
    const pipeName = `VSCode_${randomBytes(12).toString('base64')}`;
    // This is a known pipe name scheme described in the web view documentation
    // https://docs.microsoft.com/microsoft-edge/hosting/webview2/reference/webview2.idl
    const serverName = `\\\\.\\pipe\\WebView2\\Debugger\\${exeName}\\${pipeName}`;

    const server = createServer(stream => {
      stream.on('data', async data => {
        const info: IWebViewConnectionInfo = JSON.parse(data.toString());

        // devtoolsActivePort will always start with the port number
        // and look something like '92202\n ...'
        const dtString = info.devtoolsActivePort || '';
        const dtPort = parseInt(dtString.split('\n').shift() || '');
        const port = params.port || dtPort;

        promisedPort.resolve(port);

        // All web views started under our debugger are waiting to to be resumed.
        const wsURL = `ws://${params.address}:${port}/devtools/${info.type}/${info.id}`;
        const ws = await WebSocketTransport.create(wsURL, NeverCancelled);
        const connection = new CdpConnection(ws, this.logger, telemetryReporter);
        await connection.rootSession().Runtime.runIfWaitingForDebugger({});
        connection.close();
      });
    });
    server.on('error', promisedPort.reject);
    server.on('close', () => promisedPort.resolve(params.port));
    server.listen(serverName);

    // We must set a user data directory so the DevToolsActivePort file will be written.
    // See: https://crrev.com//21e1940/content/public/browser/devtools_agent_host.h#99
    params.userDataDir = params.userDataDir
      || join(tmpdir(), `vscode-js-debug-userdatadir_${params.port}`);

    // Web views are indirectly configured for debugging with environment variables.
    // See the WebView2 documentation for more details.
    params.env = params.env || {};
    params.env['WEBVIEW2_USER_DATA_FOLDER'] = params.userDataDir.toString();
    params.env['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = `--remote-debugging-port=${params.port}`;
    params.env['WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER'] = 'true';
    params.env['WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER'] = pipeName;

    return promisedPort.promise;
  }

  /**
   * @inheritdoc
   */
  protected async findBrowserPath(executablePath: string): Promise<string> {
    const resolvedPath = await this.findBrowserByExe(this.browserFinder, executablePath);
    if (!resolvedPath || !(await canAccess(this.fs, resolvedPath))) {
      throw new ProtocolError(
        browserNotFound(
          'Edge',
          executablePath,
          (await this.browserFinder.findAll()).map(b => b.quality),
        ),
      );
    }

    return resolvedPath;
  }
}
