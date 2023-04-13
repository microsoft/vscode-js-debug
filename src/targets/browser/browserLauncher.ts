/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IBrowserFinder, isQuality } from '@vscode/js-debug-browsers';
import * as fs from 'fs';
import { inject, injectable } from 'inversify';
import * as path from 'path';
import { CancellationToken } from 'vscode';
import CdpConnection from '../../cdp/connection';
import { timeoutPromise } from '../../common/cancellation';
import { DisposableList } from '../../common/disposable';
import { EnvironmentVars } from '../../common/environmentVars';
import { EventEmitter } from '../../common/events';
import { existsInjected } from '../../common/fsUtils';
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
import { FS, FsPromises, IInitializeParams, StoragePath } from '../../ioc-extras';
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
  implements ILauncher
{
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
    @inject(FS) protected readonly fs: FsPromises,
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
      includeLaunchArgs,
      runtimeArgs,
      userDataDir,
      env,
      cwd,
      port,
      url,
      file,
      inspectUri,
      webRoot,
      cleanUp,
      launchUnelevated: launchUnelevated,
    }: T,
    dap: Dap.Api,
    cancellationToken: CancellationToken,
    telemetryReporter: ITelemetryReporter,
    promisedPort?: Promise<number>,
  ): Promise<launcher.ILaunchResult> {
    const executablePath = await this.findBrowserPath(executable || 'stable');

    // If we had a custom executable, don't resolve a data
    // dir unless it's  explicitly requested.
    let resolvedDataDir: string | undefined;
    if (typeof userDataDir === 'string') {
      resolvedDataDir = path.resolve(userDataDir);
    } else if (userDataDir) {
      resolvedDataDir = path.resolve(
        path.join(
          this.storagePath,
          runtimeArgs?.includes('--headless') ? '.headless-profile' : '.profile',
        ),
      );
    }

    fs.mkdirSync(this.storagePath, { recursive: true });

    if (resolvedDataDir) {
      fs.mkdirSync(resolvedDataDir, { recursive: true });
      resolvedDataDir = fs.realpathSync(resolvedDataDir);
    }

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
        cleanUp,
        hasUserNavigation: !!(url || file),
        cwd: cwd || webRoot || undefined,
        env: EnvironmentVars.merge(EnvironmentVars.processEnv(), env),
        args: runtimeArgs || [],
        userDataDir: resolvedDataDir,
        connection: port || (inspectUri ? 0 : 'pipe'), // We don't default to pipe if we are using an inspectUri
        launchUnelevated: launchUnelevated,
        ignoreDefaultArgs: !includeDefaultArgs,
        includeLaunchArgs,
        url,
        inspectUri,
        promisedPort,
      },
    );
  }

  protected getFilterForTarget(params: T) {
    return requirePageTarget(createTargetFilterForConfig(params, ['about:blank']));
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
    const filter = this.getFilterForTarget(params);
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

    let url: string | null;
    if (params.file) {
      // Allow adding query strings or fragments onto `file` paths -- remove
      // them if there's no file on disk that match the full `file`.
      const fullFile = path.resolve(params.webRoot || params.rootPath || '', params.file);
      const di = Math.min(
        fullFile.includes('#') ? fullFile.indexOf('#') : Infinity,
        fullFile.includes('?') ? fullFile.indexOf('?') : Infinity,
      );

      if (isFinite(di) && !(await existsInjected(this.fs, fullFile))) {
        url = absolutePathToFileUrl(fullFile.slice(0, di)) + fullFile.slice(di);
      } else {
        url = absolutePathToFileUrl(fullFile);
      }
    } else {
      url = params.url;
    }

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
    await this._targetManager?.closeBrowser();
  }

  /**
   * @inheritdoc
   */
  public async restart(): Promise<void> {
    for (const target of this.targetList()) {
      if (target.type() === BrowserTargetType.Page) {
        target.restart();
      }
    }
  }

  protected async findBrowserByExe(
    finder: IBrowserFinder,
    executablePath: string,
  ): Promise<string | undefined> {
    if (executablePath === '*') {
      // try to find the stable browser, but if that fails just get any browser
      // that's available on the system
      const found =
        (await finder.findWhere(r => r.quality === 'stable')) || (await finder.findAll())[0];
      return found?.path;
    } else if (isQuality(executablePath)) {
      return (await finder.findWhere(r => r.quality === executablePath))?.path;
    } else {
      return executablePath;
    }
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
