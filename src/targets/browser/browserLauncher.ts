/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { CancellationToken } from 'vscode';
import CdpConnection from '../../cdp/connection';
import { timeoutPromise } from '../../common/cancellation';
import { EnvironmentVars } from '../../common/environmentVars';
import { EventEmitter } from '../../common/events';
import { absolutePathToFileUrl, createTargetFilterForConfig } from '../../common/urlUtils';
import { AnyChromiumLaunchConfiguration, AnyLaunchConfiguration } from '../../configuration';
import Dap from '../../dap/api';
import { ILaunchContext, ILauncher, ILaunchResult, IStopMetadata, ITarget } from '../targets';
import { ITelemetryReporter } from '../../telemetry/telemetryReporter';
import { BrowserTarget, BrowserTargetManager } from './browserTargets';
import * as launcher from './launcher';
import { ILogger } from '../../common/logging';
import { injectable, inject } from 'inversify';
import { StoragePath, IInitializeParams } from '../../ioc-extras';
import { Quality } from 'vscode-js-debug-browsers';
import { DisposableList } from '../../common/disposable';
import { ISourcePathResolver } from '../../common/sourcePathResolver';
import {
  browserLaunchFailed,
  targetPageNotFound,
  browserAttachFailed,
  ProtocolError,
} from '../../dap/errors';

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
  protected _disposables = new DisposableList();
  private _terminated = false;
  private _onTerminatedEmitter = new EventEmitter<IStopMetadata>();
  readonly onTerminated = this._onTerminatedEmitter.event;
  private _onTargetListChangedEmitter = new EventEmitter<void>();
  readonly onTargetListChanged = this._onTargetListChangedEmitter.event;

  constructor(
    @inject(StoragePath) private readonly storagePath: string,
    @inject(ILogger) protected readonly logger: ILogger,
    @inject(ISourcePathResolver) private readonly pathResolver: ISourcePathResolver,
    @inject(IInitializeParams) private readonly initializeParams: Dap.InitializeParams,
  ) {}

  /**
   * @inheritdoc
   */
  public dispose() {
    this._disposables.dispose();
  }

  /**
   * Gets the path to the browser executable.
   */
  protected abstract findBrowserPath(executablePath: string): Promise<string>;

  protected async launchBrowser(
    {
      runtimeExecutable: executable,
      trace,
      includeDefaultArgs,
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
    telemetryReporter: ITelemetryReporter,
    promisedPort?: Promise<number>,
  ): Promise<launcher.ILaunchResult> {
    const executablePath = await this.findBrowserPath(executable || Quality.Stable);

    // If we had a custom executable, don't resolve a data
    // dir unless it's  explicitly requested.
    let resolvedDataDir: string | undefined;
    if (typeof userDataDir === 'string') {
      resolvedDataDir = userDataDir;
    } else if (userDataDir) {
      resolvedDataDir = path.join(
        this.storagePath,
        runtimeArgs?.includes('--headless') ? '.headless-profile' : '.profile',
      );
    }

    try {
      fs.mkdirSync(this.storagePath);
    } catch (e) {}

    return await launcher.launch(
      dap,
      executablePath,
      this.logger,
      telemetryReporter,
      this.initializeParams,
      cancellationToken,
      {
        onStdout: output => dap.output({ category: 'stdout', output }),
        onStderr: output => dap.output({ category: 'stderr', output }),
        dumpio: typeof trace === 'boolean' ? trace : trace.stdio,
        hasUserNavigation: !!url,
        cwd: cwd || webRoot || undefined,
        env: EnvironmentVars.merge(process.env, { ELECTRON_RUN_AS_NODE: null }, env),
        args: runtimeArgs || [],
        userDataDir: resolvedDataDir,
        connection: port || (inspectUri ? 0 : 'pipe'), // We don't default to pipe if we are using an inspectUri
        launchUnelevated: launchUnelevated,
        ignoreDefaultArgs: !includeDefaultArgs,
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
  ): Promise<BrowserTarget> {
    let launched: launcher.ILaunchResult;
    try {
      launched = await this.launchBrowser(params, dap, cancellationToken, telemetryReporter);
    } catch (e) {
      throw new ProtocolError(browserLaunchFailed(e));
    }

    this._disposables.push(launched.cdp.onDisconnected(() => this.fireTerminatedEvent()));
    this._connectionForTest = launched.cdp;
    this._launchParams = params;

    this._targetManager = await BrowserTargetManager.connect(
      launched.cdp,
      launched.process,
      this.pathResolver,
      this._launchParams,
      this.logger,
      telemetryReporter,
      targetOrigin,
    );
    if (!this._targetManager) {
      throw new ProtocolError(browserAttachFailed());
    }

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
      this._targetManager.waitForMainTarget(createTargetFilterForConfig(params, ['about:blank'])),
      cancellationToken,
      'Could not attach to main target',
    );

    if (!this._mainTarget) {
      throw new ProtocolError(targetPageNotFound());
    }

    this._targetManager.onTargetRemoved((target: BrowserTarget) => {
      if (target === this._mainTarget) this.fireTerminatedEvent();
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
  ): Promise<ILaunchResult> {
    const resolved = this.resolveParams(params);
    if (!resolved) {
      return { blockSessionTermination: false };
    }

    const target = await this.prepareLaunch(resolved, context);
    await this.finishLaunch(target, resolved);
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
    await this._targetManager?.closeBrowser();
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

  fireTerminatedEvent() {
    if (!this._terminated) {
      this._terminated = true;
      this._onTerminatedEmitter.fire({ code: 0, killed: true });
    }
  }
}
