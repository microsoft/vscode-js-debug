/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as fs from 'fs';
import { inject, injectable } from 'inversify';
import * as path from 'path';
import { CancellationToken } from 'vscode';
import { Quality } from 'vscode-js-debug-browsers';
import CdpConnection from '../../cdp/connection';
import { timeoutPromise } from '../../common/cancellation';
import { DisposableList } from '../../common/disposable';
import { EnvironmentVars } from '../../common/environmentVars';
import { EventEmitter } from '../../common/events';
import { ILogger } from '../../common/logging';
import { ISourcePathResolver } from '../../common/sourcePathResolver';
import {
  absolutePathToFileUrl,
  createTargetFilterForConfig,
  requirePageTarget,
} from '../../common/urlUtils';
import { AnyChromiumLaunchConfiguration, AnyLaunchConfiguration } from '../../configuration';
import Dap from '../../dap/api';
import { browserAttachFailed, browserLaunchFailed, targetPageNotFound } from '../../dap/errors';
import { ProtocolError } from '../../dap/protocolError';
import { IInitializeParams, StoragePath } from '../../ioc-extras';
import { ITelemetryReporter } from '../../telemetry/telemetryReporter';
import { ILaunchContext, ILauncher, ILaunchResult, IStopMetadata, ITarget } from '../targets';
import { BrowserTargetManager } from './browserTargetManager';
import { BrowserTarget, BrowserTargetType } from './browserTargets';
import * as launcher from './launcher';

export interface IDapInitializeParamsWithExtensions extends Dap.InitializeParams {
  supportsLaunchUnelevatedProcessRequest?: boolean;
}

@injectable()
export abstract class BrowserLauncher<T extends AnyChromiumLaunchConfiguration>
  implements ILauncher {
  private _connectionForTest: CdpConnection | undefined;
  private _targetManager: BrowserTargetManager | undefined;
  private _launchParams: T | undefined;
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
      file,
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
        hasUserNavigation: !!(url || file),
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
      launched.process.kill();
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
    const filter = requirePageTarget(createTargetFilterForConfig(params, ['about:blank']));
    const mainTarget = await timeoutPromise(
      this._targetManager.waitForMainTarget(filter),
      cancellationToken,
      'Could not attach to main target',
    );

    if (!mainTarget) {
      launched.process.kill(); // no need to check the `cleanUp` preference since no tabs will be open
      throw new ProtocolError(targetPageNotFound());
    }

    return mainTarget;
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

  /**
   * @inheritdoc
   */
  public async terminate(): Promise<void> {
    for (const target of this.targetList() as BrowserTarget[]) {
      if (target.type() === BrowserTargetType.Page) {
        await target.cdp().Page.close({});
      }
    }
  }

  /**
   * @inheritdoc
   */
  public async disconnect(): Promise<void> {
    await this._targetManager?.closeBrowser();
  }

  /**
   * @inheritdoc
   */
  public async restart(): Promise<void> {
    const mainTarget = this.targetList().find(
      t => t.type() === BrowserTargetType.Page,
    ) as BrowserTarget;
    if (!mainTarget) {
      return;
    }

    const cdp = mainTarget.cdp();
    if (this._launchParams?.url) {
      await cdp.Page.navigate({ url: this._launchParams.url });
    } else {
      await cdp.Page.reload({});
    }

    cdp.Page.bringToFront({});
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
