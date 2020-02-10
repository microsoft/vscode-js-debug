/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { CancellationToken } from 'vscode';
import * as nls from 'vscode-nls';
import CdpConnection from '../../cdp/connection';
import { timeoutPromise } from '../../common/cancellation';
import { EnvironmentVars } from '../../common/environmentVars';
import { EventEmitter, IDisposable } from '../../common/events';
import { absolutePathToFileUrl } from '../../common/urlUtils';
import { AnyChromiumLaunchConfiguration, AnyLaunchConfiguration } from '../../configuration';
import Dap from '../../dap/api';
import { ILaunchContext, ILauncher, ILaunchResult, IStopMetadata, ITarget } from '../targets';
import { TelemetryReporter } from '../../telemetry/telemetryReporter';
import { baseURL } from './browserLaunchParams';
import { BrowserSourcePathResolver } from './browserPathResolver';
import { BrowserTarget, BrowserTargetManager } from './browserTargets';
import findBrowser from './findBrowser';
import * as launcher from './launcher';
import { ILogger } from '../../common/logging';
import { injectable, inject } from 'inversify';
import { StoragePath } from '../../ioc-extras';

const localize = nls.loadMessageBundle();

/**
 * 'magic' chrome version runtime executables.
 */
const chromeVersions = new Set<string>(['canary', 'stable', 'custom']);

export interface IDapInitializeParamsWithExtensions extends Dap.InitializeParams {
  supportsLaunchUnelevatedProcessRequest?: boolean;
}

@injectable()
export abstract class BrowserLauncher<T extends AnyChromiumLaunchConfiguration>
  implements ILauncher {
  private _connectionForTest: CdpConnection | undefined;
  private _targetManager: BrowserTargetManager | undefined;
  private _launchParams: T | undefined;
  protected _mainTarget?: BrowserTarget;
  private _disposables: IDisposable[] = [];
  private _onTerminatedEmitter = new EventEmitter<IStopMetadata>();
  readonly onTerminated = this._onTerminatedEmitter.event;
  private _onTargetListChangedEmitter = new EventEmitter<void>();
  readonly onTargetListChanged = this._onTargetListChangedEmitter.event;

  constructor(
    @inject(StoragePath) private readonly storagePath: string,
    @inject(ILogger) protected readonly logger: ILogger,
  ) {}

  dispose() {
    for (const disposable of this._disposables) disposable.dispose();
    this._disposables = [];
  }

  protected async launchBrowser(
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
    }: T,
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
        this.storagePath,
        runtimeArgs?.includes('--headless') ? '.headless-profile' : '.profile',
      );
    } else if (typeof userDataDir === 'string') {
      resolvedDataDir = userDataDir;
    }

    try {
      fs.mkdirSync(this.storagePath);
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

  /**
   * Starts the launch process. It boots the browser and waits until the target
   * page is available, and then returns the newly-created target.
   */
  private async prepareLaunch(
    params: T,
    { dap, targetOrigin, cancellationToken, telemetryReporter }: ILaunchContext,
    clientCapabilities: IDapInitializeParamsWithExtensions,
  ): Promise<BrowserTarget | string> {
    let launched: launcher.ILaunchResult;
    try {
      launched = await this.launchBrowser(
        params,
        dap,
        cancellationToken,
        telemetryReporter,
        clientCapabilities,
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

    // Note: assuming first page is our main target breaks multiple debugging sessions
    // sharing the browser instance. This can be fixed.
    this._mainTarget = await timeoutPromise(
      this._targetManager.waitForMainTarget(),
      cancellationToken,
      'Could not attach to main target',
    );

    if (!this._mainTarget) return localize('error.threadNotFound', 'Target page not found');
    this._targetManager.onTargetRemoved((target: BrowserTarget) => {
      if (target === this._mainTarget) this._onTerminatedEmitter.fire({ code: 0, killed: true });
    });
    return this._mainTarget;
  }

  /**
   * Finalizes the launch after a page is available, navigating to the
   * requested URL.
   */
  private async finishLaunch(mainTarget: BrowserTarget, params: T): Promise<void> {
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

  /**
   * @inheritdoc
   */
  public async launch(
    params: AnyLaunchConfiguration,
    context: ILaunchContext,
    clientCapabilities: Dap.InitializeParams,
  ): Promise<ILaunchResult> {
    const resolved = this.resolveParams(params);
    if (!resolved) {
      return { blockSessionTermination: false };
    }

    const targetOrError = await this.prepareLaunch(resolved, context, clientCapabilities);
    if (typeof targetOrError === 'string') {
      return { error: targetOrError };
    }

    await this.finishLaunch(targetOrError, resolved);
    return { blockSessionTermination: true };
  }

  /**
   * Returns the params type if they can be launched by this launcher,
   * or undefined if they cannot.
   */
  protected abstract resolveParams(params: AnyLaunchConfiguration): T | undefined;

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
    const manager = this._targetManager;
    return manager ? manager.targetList() : [];
  }

  connectionForTest(): CdpConnection | undefined {
    return this._connectionForTest;
  }
}
