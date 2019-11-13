// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as fs from 'fs';
import * as path from 'path';
import { Disposable, EventEmitter } from '../../common/events';
import * as nls from 'vscode-nls';
import CdpConnection from '../../cdp/connection';
import findBrowser from './findBrowser';
import * as launcher from './launcher';
import { BrowserTarget, BrowserTargetManager } from './browserTargets';
import { Target, Launcher, LaunchResult, ILaunchContext, IStopMetadata } from '../../targets/targets';
import { BrowserSourcePathResolver } from './browserPathResolver';
import { baseURL } from './browserLaunchParams';
import { AnyChromeConfiguration, IChromeLaunchConfiguration } from '../../configuration';
import { Contributions } from '../../common/contributionUtils';
import { EnvironmentVars } from '../../common/environmentVars';
import { ScriptSkipper } from '../../adapter/scriptSkipper';
import { RawTelemetryReporterToDap, RawTelemetryReporter } from '../../telemetry/telemetryReporter';
import { absolutePathToFileUrl } from '../../common/urlUtils';
import { cancellableRace } from '../../common/cancellation';
import { CancellationToken } from 'vscode';

const localize = nls.loadMessageBundle();

export class BrowserLauncher implements Launcher {
  private _connectionForTest: CdpConnection | undefined;
  private _storagePath: string;
  private _targetManager: BrowserTargetManager | undefined;
  private _launchParams: IChromeLaunchConfiguration | undefined;
  private _mainTarget?: BrowserTarget;
  private _disposables: Disposable[] = [];
  private _onTerminatedEmitter = new EventEmitter<IStopMetadata>();
  readonly onTerminated = this._onTerminatedEmitter.event;
  private _onTargetListChangedEmitter = new EventEmitter<void>();
  readonly onTargetListChanged = this._onTargetListChangedEmitter.event;

  constructor(storagePath: string) {
    this._storagePath = storagePath;
  }

  targetManager(): BrowserTargetManager | undefined {
    return this._targetManager;
  }

  dispose() {
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables = [];
  }

  async _launchBrowser({ runtimeExecutable: executable, runtimeArgs, userDataDir, env, cwd, port }: IChromeLaunchConfiguration, cancellationToken: CancellationToken, rawTelemetryReporter: RawTelemetryReporter): Promise<CdpConnection> {
    let executablePath = '';
    if (executable && executable !== 'canary' && executable !== 'stable' && executable !== 'custom') {
      executablePath = executable;
    } else {
      const installations = findBrowser();
      if (executable) {
        const installation = installations.find(e => e.type === executable);
        if (installation)
          executablePath = installation.path;
      } else {
        // Prefer canary over stable, it comes earlier in the list.
        if (installations.length)
          executablePath = installations[0].path;
      }
    }

    let resolvedDataDir: string | undefined;
    if (userDataDir === true) {
        resolvedDataDir = path.join(this._storagePath, runtimeArgs && runtimeArgs.includes('--headless') ? '.headless-profile' : '.profile');
    } else if (typeof userDataDir === 'string') {
      resolvedDataDir = userDataDir;
    }

    if (!executablePath)
      throw new Error('Unable to find browser');

    try {
      fs.mkdirSync(this._storagePath);
    } catch (e) {
    }

    return await launcher.launch(
      executablePath, rawTelemetryReporter, cancellationToken, {
        cwd: cwd || undefined,
        env: EnvironmentVars.merge(process.env, env),
        args: runtimeArgs || [],
        userDataDir: resolvedDataDir,
        connection: port || 'pipe',
      });
  }

  async prepareLaunch(params: IChromeLaunchConfiguration, { targetOrigin, cancellationToken }: ILaunchContext, rawTelemetryReporter: RawTelemetryReporter): Promise<BrowserTarget | string> {
    let connection: CdpConnection;
    try {
      connection = await this._launchBrowser(params, cancellationToken, rawTelemetryReporter);
    } catch (e) {
      return localize('error.browserLaunchError', 'Unable to launch browser: "{0}"', e.message);
    }

    connection.onDisconnected(() => {
      this._onTerminatedEmitter.fire({ code: 0, killed: true });
    }, undefined, this._disposables);
    this._connectionForTest = connection;
    this._launchParams = params;

    const pathResolver = new BrowserSourcePathResolver({
      baseUrl: baseURL(params),
      localRoot: null,
      remoteRoot: null,
      webRoot: params.webRoot || params.rootPath,
      sourceMapOverrides: params.sourceMapPathOverrides,
    });
    this._targetManager = await BrowserTargetManager.connect(connection, pathResolver, this._launchParams, rawTelemetryReporter, targetOrigin);
    if (!this._targetManager)
      return localize('error.unableToAttachToBrowser', 'Unable to attach to the browser');

    this._targetManager.serviceWorkerModel.onDidChange(() => this._onTargetListChangedEmitter.fire());
    this._targetManager.frameModel.onFrameNavigated(() => this._onTargetListChangedEmitter.fire());
    this._disposables.push(this._targetManager);

    this._targetManager.onTargetAdded((target: BrowserTarget) => {
      this._onTargetListChangedEmitter.fire();
    });
    this._targetManager.onTargetRemoved((target: BrowserTarget) => {
      this._onTargetListChangedEmitter.fire();
    });

    if (params.skipFiles) {
      this._targetManager.setSkipFiles(new ScriptSkipper(params.skipFiles));
    }

    // Note: assuming first page is our main target breaks multiple debugging sessions
    // sharing the browser instance. This can be fixed.
    this._mainTarget = await cancellableRace(
      this._targetManager.waitForMainTarget(),
      cancellationToken,
      'Could not attach to main target',
    );

    if (!this._mainTarget)
      return localize('error.threadNotFound', 'Target page not found');
    this._targetManager.onTargetRemoved((target: BrowserTarget) => {
      if (target === this._mainTarget)
        this._onTerminatedEmitter.fire({ code: 0, killed: true });
    });
    return this._mainTarget;
  }

  private async finishLaunch(mainTarget: BrowserTarget, params: AnyChromeConfiguration): Promise<void> {
    if ('skipNavigateForTest' in params) {
      return;
    }

    const url = 'file' in params && params.file
      ? absolutePathToFileUrl(path.resolve(params.webRoot || params.rootPath || '', params.file))
      : params.url;

    if (url) {
      await mainTarget.cdp().Page.navigate({ url });
    }
  }

  async launch(params: AnyChromeConfiguration, context: ILaunchContext, telemetryReporter: RawTelemetryReporterToDap): Promise<LaunchResult> {
    if (params.type !== Contributions.ChromeDebugType || params.request !== 'launch') {
      return { blockSessionTermination: false };
    }

    const targetOrError = await this.prepareLaunch(params, context, telemetryReporter);
    if (typeof targetOrError === 'string')
      return { error: targetOrError };
    await this.finishLaunch(targetOrError, params);
    return { blockSessionTermination: true };
  }

  async terminate(): Promise<void> {
    if (this._mainTarget)
      this._mainTarget.cdp().Page.navigate({ url: 'about:blank' });
  }

  async disconnect(): Promise<void> {
    if (this._targetManager)
      await this._targetManager.closeBrowser();
  }

  async restart(): Promise<void> {
    if (!this._mainTarget)
      return;
    if (this._launchParams!.url)
      await this._mainTarget.cdp().Page.navigate({ url: this._launchParams!.url });
    else
      await this._mainTarget.cdp().Page.reload({ });
  }

  targetList(): Target[] {
    const manager = this.targetManager()
    return manager ? manager.targetList() : [];
  }

  connectionForTest(): CdpConnection | undefined {
    return this._connectionForTest;
  }
}
