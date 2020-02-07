/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { createServer } from 'net';
import { randomBytes } from 'crypto';
import { tmpdir } from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { CancellationToken } from 'vscode';
import * as nls from 'vscode-nls';
import CdpConnection from '../../cdp/connection';
import { timeoutPromise, NeverCancelled } from '../../common/cancellation';
import { Contributions } from '../../common/contributionUtils';
import { EnvironmentVars } from '../../common/environmentVars';
import { EventEmitter, IDisposable } from '../../common/events';
import { absolutePathToFileUrl, createTargetFilterForConfig } from '../../common/urlUtils';
import { AnyChromeConfiguration, IChromeLaunchConfiguration } from '../../configuration';
import Dap from '../../dap/api';
import {
  ILaunchContext,
  ILauncher,
  ILaunchResult,
  IStopMetadata,
  ITarget,
  IWebViewConnectionInfo,
} from '../../targets/targets';
import { TelemetryReporter } from '../../telemetry/telemetryReporter';
import { baseURL } from './browserLaunchParams';
import { BrowserSourcePathResolver } from './browserPathResolver';
import { BrowserTarget, BrowserTargetManager } from './browserTargets';
import findBrowser from './findBrowser';
import * as launcher from './launcher';
import { WebSocketTransport } from '../../cdp/transport';
import { getDeferred } from '../../common/promiseUtil';
import { ILogger } from '../../common/logging';

const localize = nls.loadMessageBundle();

/**
 * 'magic' chrome version runtime executables.
 */
const chromeVersions = new Set<string>(['canary', 'stable', 'custom']);

export interface IDapInitializeParamsWithExtensions extends Dap.InitializeParams {
  supportsLaunchUnelevatedProcessRequest?: boolean;
}

export class BrowserLauncher implements ILauncher {
  private _connectionForTest: CdpConnection | undefined;
  private _storagePath: string;
  private _targetManager: BrowserTargetManager | undefined;
  private _launchParams: IChromeLaunchConfiguration | undefined;
  private _mainTarget?: BrowserTarget;
  private _disposables: IDisposable[] = [];
  private _onTerminatedEmitter = new EventEmitter<IStopMetadata>();
  readonly onTerminated = this._onTerminatedEmitter.event;
  private _onTargetListChangedEmitter = new EventEmitter<void>();
  readonly onTargetListChanged = this._onTargetListChangedEmitter.event;

  constructor(storagePath: string, private readonly logger: ILogger) {
    this._storagePath = storagePath;
  }

  targetManager(): BrowserTargetManager | undefined {
    return this._targetManager;
  }

  dispose() {
    for (const disposable of this._disposables) disposable.dispose();
    this._disposables = [];
  }

  async _launchBrowser(
    {
      runtimeExecutable: executable,
      runtimeArgs,
      userDataDir,
      env,
      cwd,
      port,
      url,
      inspectUri,
      webRoot,
      launchUnelevated: launchUnelevated,
    }: IChromeLaunchConfiguration,
    dap: Dap.Api,
    cancellationToken: CancellationToken,
    telemetryReporter: TelemetryReporter,
    clientCapabilities: IDapInitializeParamsWithExtensions,
    promisedPort?: Promise<number>,
  ): Promise<launcher.ILaunchResult> {
    let executablePath: string | undefined;
    if (executable && !chromeVersions.has(executable)) {
      executablePath = executable;
    } else {
      const installations = findBrowser();
      if (executable) {
        const installation = installations.find(e => e.type === executable);
        if (installation) {
          executablePath = installation.path;
        }
      } else {
        // Prefer canary over stable, it comes earlier in the list.
        if (installations.length) {
          executablePath = installations[0].path;
        }
      }

      if (!executablePath) {
        const available = installations.map(i => i.type).join(', ');
        throw new Error(
          `Unable to find Chrome version ${executable}. ` +
            (available ? `Available versions are: ${available}. ` : '') +
            'You can set the "runtimeExecutable" in your launch.json to the path to Chrome',
        );
      }
    }

    // If we had a custom executable, don't resolve a data
    // dir unless it's  explicitly requested.
    let resolvedDataDir: string | undefined;
    if (!executable || chromeVersions.has(executable) || userDataDir === true) {
      resolvedDataDir = path.join(
        this._storagePath,
        runtimeArgs?.includes('--headless') ? '.headless-profile' : '.profile',
      );
    } else if (typeof userDataDir === 'string') {
      resolvedDataDir = userDataDir;
    }

    try {
      fs.mkdirSync(this._storagePath);
    } catch (e) {}

    return await launcher.launch(
      dap,
      executablePath,
      this.logger,
      telemetryReporter,
      clientCapabilities,
      cancellationToken,
      {
        onStdout: output => dap.output({ category: 'stdout', output }),
        onStderr: output => dap.output({ category: 'stderr', output }),
        hasUserNavigation: !!url,
        cwd: cwd || webRoot || undefined,
        env: EnvironmentVars.merge(process.env, { ELECTRON_RUN_AS_NODE: null }, env),
        args: runtimeArgs || [],
        userDataDir: resolvedDataDir,
        connection: port || (inspectUri ? 0 : 'pipe'), // We don't default to pipe if we are using an inspectUri
        launchUnelevated: launchUnelevated,
        url,
        inspectUri,
        promisedPort,
      },
    );
  }

  async prepareWebViewLaunch(
    params: IChromeLaunchConfiguration,
    filter: (info: IWebViewConnectionInfo) => boolean,
    telemetryReporter: TelemetryReporter,
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
        const port = params.port || dtPort || params.port;

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
    server.on('close', () => promisedPort.resolve(params.port));
    server.listen(serverName);

    // We must set a user data directory so the DevToolsActivePort file will be written.
    // See: https://crrev.com//21e1940/content/public/browser/devtools_agent_host.h#99
    params.userDataDir =
      params.userDataDir || path.join(tmpdir(), `vscode-js-debug-userdatadir_${params.port}`);

    // Web views are indirectly configured for debugging with environment variables.
    // See the WebView2 documentation for more details.
    params.env = params.env || {};
    params.env['WEBVIEW2_USER_DATA_FOLDER'] = params.userDataDir.toString();
    params.env['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = `--remote-debugging-port=${params.port}`;
    params.env['WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER'] = 'true';
    params.env['WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER'] = pipeName;

    return promisedPort.promise;
  }

  async prepareLaunch(
    params: IChromeLaunchConfiguration,
    { dap, targetOrigin, cancellationToken, telemetryReporter }: ILaunchContext,
    clientCapabilities: IDapInitializeParamsWithExtensions,
  ): Promise<BrowserTarget | string> {
    const targetFilter = createTargetFilterForConfig(params);
    const promisedPort = params.useWebView
      ? this.prepareWebViewLaunch(params, targetFilter, telemetryReporter)
      : undefined;

    let launched: launcher.ILaunchResult;
    try {
      launched = await this._launchBrowser(
        params,
        dap,
        cancellationToken,
        telemetryReporter,
        clientCapabilities,
        promisedPort,
      );
    } catch (e) {
      return localize('error.browserLaunchError', 'Unable to launch browser: "{0}"', e.message);
    }

    launched.cdp.onDisconnected(
      () => {
        this._onTerminatedEmitter.fire({ code: 0, killed: true });
      },
      undefined,
      this._disposables,
    );
    this._connectionForTest = launched.cdp;
    this._launchParams = params;

    const pathResolver = new BrowserSourcePathResolver(
      {
        resolveSourceMapLocations: params.resolveSourceMapLocations,
        baseUrl: baseURL(params),
        localRoot: null,
        remoteRoot: null,
        pathMapping: { '/': params.webRoot, ...params.pathMapping },
        sourceMapOverrides: params.sourceMapPathOverrides,
        clientID: clientCapabilities.clientID,
      },
      this.logger,
    );
    this._targetManager = await BrowserTargetManager.connect(
      launched.cdp,
      launched.process,
      pathResolver,
      this._launchParams,
      this.logger,
      telemetryReporter,
      targetOrigin,
    );
    if (!this._targetManager)
      return localize('error.unableToAttachToBrowser', 'Unable to attach to the browser');

    this._targetManager.serviceWorkerModel.onDidChange(() =>
      this._onTargetListChangedEmitter.fire(),
    );
    this._targetManager.frameModel.onFrameNavigated(() => this._onTargetListChangedEmitter.fire());
    this._disposables.push(this._targetManager);

    this._targetManager.onTargetAdded(() => {
      this._onTargetListChangedEmitter.fire();
    });
    this._targetManager.onTargetRemoved(() => {
      this._onTargetListChangedEmitter.fire();
    });

    const filter = params.useWebView ? targetFilter : undefined;

    // Note: assuming first page is our main target breaks multiple debugging sessions
    // sharing the browser instance. This can be fixed.
    this._mainTarget = await timeoutPromise(
      this._targetManager.waitForMainTarget(filter),
      cancellationToken,
      'Could not attach to main target',
    );

    if (!this._mainTarget) return localize('error.threadNotFound', 'Target page not found');
    this._targetManager.onTargetRemoved((target: BrowserTarget) => {
      if (target === this._mainTarget) this._onTerminatedEmitter.fire({ code: 0, killed: true });
    });
    return this._mainTarget;
  }

  private async finishLaunch(
    mainTarget: BrowserTarget,
    params: AnyChromeConfiguration,
  ): Promise<void> {
    if ('skipNavigateForTest' in params) {
      return;
    }

    const url =
      'file' in params && params.file
        ? absolutePathToFileUrl(path.resolve(params.webRoot || params.rootPath || '', params.file))
        : params.url;

    if (url) {
      await mainTarget.cdp().Page.navigate({ url });
    }
  }

  async launch(
    params: AnyChromeConfiguration,
    context: ILaunchContext,
    clientCapabilities: Dap.InitializeParams,
  ): Promise<ILaunchResult> {
    if (params.type !== Contributions.ChromeDebugType || params.request !== 'launch') {
      return { blockSessionTermination: false };
    }

    const targetOrError = await this.prepareLaunch(params, context, clientCapabilities);
    if (typeof targetOrError === 'string') return { error: targetOrError };
    await this.finishLaunch(targetOrError, params);
    return { blockSessionTermination: true };
  }

  async terminate(): Promise<void> {
    if (this._mainTarget) {
      await this._mainTarget.cdp().Page.navigate({ url: 'about:blank' });
    }
  }

  async disconnect(): Promise<void> {
    if (this._targetManager) await this._targetManager.closeBrowser();
  }

  async restart(): Promise<void> {
    if (!this._mainTarget) return;
    if (this._launchParams?.url)
      await this._mainTarget.cdp().Page.navigate({ url: this._launchParams.url });
    else await this._mainTarget.cdp().Page.reload({});
  }

  targetList(): ITarget[] {
    const manager = this.targetManager();
    return manager ? manager.targetList() : [];
  }

  connectionForTest(): CdpConnection | undefined {
    return this._connectionForTest;
  }
}
