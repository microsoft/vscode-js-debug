/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IDisposable, EventEmitter } from '../../common/events';
import CdpConnection from '../../cdp/connection';
import * as launcher from './launcher';
import * as nls from 'vscode-nls';
import { BrowserTargetManager } from './browserTargets';
import { ITarget, ILauncher, ILaunchResult, ILaunchContext, IStopMetadata } from '../targets';
import { BrowserSourcePathResolver } from './browserPathResolver';
import { baseURL } from './browserLaunchParams';
import { AnyLaunchConfiguration, IChromeAttachConfiguration } from '../../configuration';
import { Contributions } from '../../common/contributionUtils';
import { RawTelemetryReporterToDap } from '../../telemetry/telemetryReporter';
import { createTargetFilterForConfig } from '../../common/urlUtils';
import { delay } from '../../common/promiseUtil';
import { CancellationToken } from 'vscode';
import { NeverCancelled } from '../../common/cancellation';
import { Dap } from '../../dap/api';

const localize = nls.loadMessageBundle();

export class BrowserAttacher implements ILauncher {
  private _attemptTimer: NodeJS.Timer | undefined;
  private _connection: CdpConnection | undefined;
  private _targetManager: BrowserTargetManager | undefined;
  private _launchParams: IChromeAttachConfiguration | undefined;
  private _targetOrigin: any;
  private _disposables: IDisposable[] = [];
  private _onTerminatedEmitter = new EventEmitter<IStopMetadata>();
  readonly onTerminated = this._onTerminatedEmitter.event;
  private _onTargetListChangedEmitter = new EventEmitter<void>();
  readonly onTargetListChanged = this._onTargetListChangedEmitter.event;

  targetManager(): BrowserTargetManager | undefined {
    return this._targetManager;
  }

  dispose() {
    for (const disposable of this._disposables) disposable.dispose();
    this._disposables = [];
    if (this._attemptTimer) clearTimeout(this._attemptTimer);
    if (this._targetManager) this._targetManager.dispose();
  }

  async launch(
    params: AnyLaunchConfiguration,
    { targetOrigin, cancellationToken }: ILaunchContext,
    rawTelemetryReporter: RawTelemetryReporterToDap,
    clientCapabilities: Dap.InitializeParams,
  ): Promise<ILaunchResult> {
    if (params.type !== Contributions.ChromeDebugType || params.request !== 'attach') {
      return { blockSessionTermination: false };
    }

    this._launchParams = params;
    this._targetOrigin = targetOrigin;

    const error = await this._attemptToAttach(
      rawTelemetryReporter,
      clientCapabilities,
      cancellationToken,
    );
    return error ? { error } : { blockSessionTermination: false };
  }

  _scheduleAttach(
    rawTelemetryReporter: RawTelemetryReporterToDap,
    clientCapabilities: Dap.InitializeParams,
  ) {
    this._attemptTimer = setTimeout(() => {
      this._attemptTimer = undefined;
      this._attemptToAttach(rawTelemetryReporter, clientCapabilities, NeverCancelled);
    }, 1000);
  }

  async _attemptToAttach(
    rawTelemetryReporter: RawTelemetryReporterToDap,
    clientCapabilities: Dap.InitializeParams,
    cancellationToken: CancellationToken,
  ) {
    const params = this._launchParams!;
    const connection = await this.acquireConnectionForBrowser(
      rawTelemetryReporter,
      params,
      cancellationToken,
    );
    if (typeof connection === 'string') {
      return connection; // an error
    }

    this._connection = connection;
    connection.onDisconnected(
      () => {
        this._connection = undefined;
        if (this._targetManager) {
          this._targetManager.dispose();
          this._targetManager = undefined;
          this._onTargetListChangedEmitter.fire();
        }
        if (this._launchParams === params) {
          this._scheduleAttach(rawTelemetryReporter, clientCapabilities);
        }
      },
      undefined,
      this._disposables,
    );

    const pathResolver = new BrowserSourcePathResolver({
      resolveSourceMapLocations: params.resolveSourceMapLocations,
      baseUrl: baseURL(params),
      localRoot: null,
      remoteRoot: null,
      webRoot: params.webRoot || params.rootPath,
      sourceMapOverrides: params.sourceMapPathOverrides,
      clientID: clientCapabilities.clientID,
    });
    this._targetManager = await BrowserTargetManager.connect(
      connection,
      undefined,
      pathResolver,
      params,
      rawTelemetryReporter,
      this._targetOrigin,
    );
    if (!this._targetManager) return;

    this._targetManager.serviceWorkerModel.onDidChange(() =>
      this._onTargetListChangedEmitter.fire(),
    );
    this._targetManager.frameModel.onFrameNavigated(() => this._onTargetListChangedEmitter.fire());
    this._targetManager.onTargetAdded(() => {
      this._onTargetListChangedEmitter.fire();
    });
    this._targetManager.onTargetRemoved(() => {
      this._onTargetListChangedEmitter.fire();
    });

    const result = await Promise.race([
      this._targetManager.waitForMainTarget(createTargetFilterForConfig(params)),
      delay(params.timeout).then(() =>
        localize(
          'chrome.attach.noMatchingTarget',
          "Can't find a valid target that matches {0} within {1}ms",
          params.urlFilter || params.url,
          params.timeout,
        ),
      ),
    ]);

    return typeof result === 'string' ? result : undefined;
  }

  private async acquireConnectionForBrowser(
    rawTelemetryReporter: RawTelemetryReporterToDap,
    params: IChromeAttachConfiguration,
    cancellationToken: CancellationToken,
  ) {
    const browserURL = `http://${params.address}:${params.port}`;
    while (this._launchParams === params) {
      try {
        return await launcher.attach({ browserURL }, cancellationToken, rawTelemetryReporter);
      } catch (e) {
        if (cancellationToken.isCancellationRequested) {
          return localize(
            'attach.cannotConnect',
            'Cannot connect to the target at {0}: {1}',
            browserURL,
            e.message,
          );
        }

        await delay(1000);
      }
    }

    return localize(
      'attach.cannotConnect',
      'Cannot connect to the target at {0}: {1}',
      browserURL,
      'Cancelled',
    );
  }

  async terminate(): Promise<void> {
    this._launchParams = undefined;
    if (this._connection) this._connection.close();
  }

  async disconnect(): Promise<void> {
    // no-op
  }

  async restart(): Promise<void> {
    // no-op
  }

  targetList(): ITarget[] {
    const manager = this.targetManager();
    return manager ? manager.targetList() : [];
  }
}
