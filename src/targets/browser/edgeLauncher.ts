/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { createServer } from 'net';
import { randomBytes } from 'crypto';
import { tmpdir } from 'os';
import CdpConnection from '../../cdp/connection';
import { IEdgeLaunchConfiguration, AnyLaunchConfiguration } from '../../configuration';
import { IWebViewConnectionInfo } from '../targets';
import { ITelemetryReporter } from '../../telemetry/telemetryReporter';
import { getDeferred } from '../../common/promiseUtil';
import { WebSocketTransport } from '../../cdp/webSocketTransport';
import { NeverCancelled } from '../../common/cancellation';
import { join } from 'path';
import Dap from '../../dap/api';
import { CancellationToken } from 'vscode';
import { createTargetFilterForConfig } from '../../common/urlUtils';
import { BrowserLauncher } from './browserLauncher';
import { DebugType } from '../../common/contributionUtils';
import { StoragePath, FS, FsPromises, BrowserFinder, IInitializeParams } from '../../ioc-extras';
import { inject, tagged, injectable } from 'inversify';
import { ILogger } from '../../common/logging';
import { once } from '../../common/objUtils';
import { canAccess } from '../../common/fsUtils';
import { browserNotFound, ProtocolError } from '../../dap/errors';
import { IBrowserFinder, isQuality } from 'vscode-js-debug-browsers';
import { ISourcePathResolver } from '../../common/sourcePathResolver';

@injectable()
export class EdgeLauncher extends BrowserLauncher<IEdgeLaunchConfiguration> {
  constructor(
    @inject(StoragePath) storagePath: string,
    @inject(ILogger) logger: ILogger,
    @inject(BrowserFinder)
    @tagged('browser', 'edge')
    protected readonly browserFinder: IBrowserFinder,
    @inject(FS)
    private readonly fs: FsPromises,
    @inject(ISourcePathResolver) pathResolver: ISourcePathResolver,
    @inject(IInitializeParams) initializeParams: Dap.InitializeParams,
  ) {
    super(storagePath, logger, pathResolver, initializeParams);
  }

  /**
   * @inheritdoc
   */
  protected resolveParams(params: AnyLaunchConfiguration) {
    return params.type === DebugType.Edge &&
      params.request === 'launch' &&
      params.browserLaunchLocation === 'workspace'
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
      params,
      dap,
      cancellationToken,
      telemetryReporter,
      params.useWebView
        ? this.getWebviewPort(params, createTargetFilterForConfig(params), telemetryReporter)
        : undefined,
    );
  }

  /**
   * Gets the port number we should connect to to debug webviews in the target.
   */
  private async getWebviewPort(
    params: IEdgeLaunchConfiguration,
    filter: (info: IWebViewConnectionInfo) => boolean,
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

        if (!this._mainTarget && filter(info)) {
          promisedPort.resolve(port);
        }

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
    params.userDataDir =
      params.userDataDir || join(tmpdir(), `vscode-js-debug-userdatadir_${params.port}`);

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
    let resolvedPath: string | undefined;

    const discover = once(() => this.browserFinder.findAll());
    if (isQuality(executablePath)) {
      resolvedPath = (await discover()).find(r => r.quality === executablePath)?.path;
    } else {
      resolvedPath = executablePath;
    }

    if (!resolvedPath || !(await canAccess(this.fs, resolvedPath))) {
      throw new ProtocolError(
        browserNotFound(
          'Edge',
          executablePath,
          (await discover()).map(b => b.quality),
        ),
      );
    }

    return resolvedPath;
  }
}
