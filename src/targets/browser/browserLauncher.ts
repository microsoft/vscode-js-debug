/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IBrowserFinder, isQuality } from '@vscode/js-debug-browsers';
import * as l10n from '@vscode/l10n';
import * as fs from 'fs';
import { inject, injectable } from 'inversify';
import * as path from 'path';
import { CancellationToken } from 'vscode';
import CdpConnection from '../../cdp/connection';
import { CancellationTokenSource, timeoutPromise } from '../../common/cancellation';
import { DisposableList } from '../../common/disposable';
import { EnvironmentVars } from '../../common/environmentVars';
import { EventEmitter } from '../../common/events';
import { existsInjected } from '../../common/fsUtils';
import { ILogger } from '../../common/logging';
import { delay } from '../../common/promiseUtil';
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
  protected _disposables = new DisposableList();
  private _onTerminatedEmitter = new EventEmitter<IStopMetadata>();
  readonly onTerminated = this._onTerminatedEmitter.event;
  private _onTargetListChangedEmitter = new EventEmitter<void>();
  readonly onTargetListChanged = this._onTargetListChangedEmitter.event;
  private readonly _terminatedCts = new CancellationTokenSource();

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
  private async doLaunch(params: T, ctx: ILaunchContext): Promise<void> {
    let launched: launcher.ILaunchResult;
    try {
      launched = await this.launchBrowser(
        params,
        ctx.dap,
        ctx.cancellationToken,
        ctx.telemetryReporter,
      );
    } catch (e) {
      throw new ProtocolError(browserLaunchFailed(e));
    }

    // Note: we have a different token for the launch loop, since the initial
    // launch token is cancelled when that finishes. Instead, this token is
    // good until the debug session is terminated, once the initial session
    // has been craeted.
    const launchCts = new CancellationTokenSource(this._terminatedCts.token);

    // Retry connections as long as the launch process is running,
    // reconnections are allowed, and this debug session hasn't been terminated.
    launched.process.onExit(() => this.fireTerminatedEvent());
    const canRetry = () => launched.canReconnect && !launchCts.token.isCancellationRequested;

    const onConnectionFailed = async (err?: Error): Promise<void> => {
      // cleanup old target manager immediately so sessions are reflected
      this._targetManager?.dispose();
      this._targetManager = undefined;
      this._onTargetListChangedEmitter.fire();

      if (canRetry()) {
        // this looks ugly, because it is... if the browser is closed by the
        // user, we'll generally notice the CDP connection is closed before the
        // process' exit event happens, so add an extra delay to double check
        // that a retry is appropriate to avoid extranous logs.
        await delay(1000);
        if (canRetry()) {
          ctx.dap.output({
            category: 'stderr',
            output: l10n.t(
              'Browser connection failed, will retry: {0}',
              err?.message || 'Connection closed',
            ),
          });

          try {
            await delay(2000);
            return await launchInner();
          } catch {
            // caught in here because twe could no longer retry. fall through.
          }
        }
      }

      launched.process.kill();
      this.fireTerminatedEvent();
    };

    const launchInner = async (): Promise<void> => {
      if (launchCts.token.isCancellationRequested) {
        return;
      }

      try {
        const cdp = await launched.createConnection(launchCts.token);

        const target = await this.launchCdp(params, launched, cdp, {
          ...ctx,
          cancellationToken: launchCts.token,
        });
        await this.finishLaunch(target, params);
        cdp.onDisconnected(() => onConnectionFailed());
      } catch (e) {
        if (canRetry()) {
          return onConnectionFailed(e);
        } else {
          launched.process.kill();
          throw new ProtocolError(browserLaunchFailed(e));
        }
      }
    };

    const launchTokenListener = ctx.cancellationToken.onCancellationRequested(() =>
      launchCts.cancel()
    );

    try {
      await launchInner();
    } finally {
      launchTokenListener.dispose();
    }
  }

  private async launchCdp(
    params: T,
    launched: launcher.ILaunchResult,
    cdp: CdpConnection,
    ctx: ILaunchContext,
  ) {
    this._connectionForTest = cdp;

    this._targetManager = await BrowserTargetManager.connect(
      cdp,
      launched.process,
      this.pathResolver,
      params,
      this.logger,
      ctx.telemetryReporter,
      ctx.targetOrigin,
    );
    if (!this._targetManager) {
      throw new ProtocolError(browserAttachFailed());
    }

    this._targetManager.serviceWorkerModel.onDidChange(() =>
      this._onTargetListChangedEmitter.fire()
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
      ctx.cancellationToken,
      'Could not attach to main target',
    );

    if (!mainTarget) {
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

    await this.doLaunch(resolved, context);
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
    if (this._targetManager) {
      await this._targetManager.closeBrowser();
    } else {
      this.fireTerminatedEvent();
    }
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
      const found = (await finder.findWhere(r => r.quality === 'stable'))
        || (await finder.findAll())[0];
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
    if (!this._terminatedCts.token.isCancellationRequested) {
      this._terminatedCts.cancel();
      this._onTerminatedEmitter.fire({ code: 0, killed: true });
    }
  }
}
