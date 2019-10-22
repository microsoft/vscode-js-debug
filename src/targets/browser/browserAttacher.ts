// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Disposable, EventEmitter } from '../../common/events';
import CdpConnection from '../../cdp/connection';
import * as launcher from './launcher';
import { BrowserTarget, BrowserTargetManager } from './browserTargets';
import { Target, Launcher, LaunchResult, ILaunchContext } from '../targets';
import { BrowserSourcePathResolver } from './browserPathResolver';
import { baseURL } from './browserLaunchParams';
import { AnyLaunchConfiguration, IChromeAttachConfiguration } from '../../configuration';
import { Contributions } from '../../common/contributionUtils';

export class BrowserAttacher implements Launcher {
  private _attemptTimer: NodeJS.Timer | undefined;
  private _connection: CdpConnection | undefined;
  private _targetManager: BrowserTargetManager | undefined;
  private _launchParams: IChromeAttachConfiguration | undefined;
  private _targetOrigin: any;
  private _disposables: Disposable[] = [];
  private _onTerminatedEmitter = new EventEmitter<void>();
  readonly onTerminated = this._onTerminatedEmitter.event;
  private _onTargetListChangedEmitter = new EventEmitter<void>();
  readonly onTargetListChanged = this._onTargetListChangedEmitter.event;

  targetManager(): BrowserTargetManager | undefined {
    return this._targetManager;
  }

  dispose() {
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables = [];
    if (this._attemptTimer)
      clearTimeout(this._attemptTimer);
    if (this._targetManager)
      this._targetManager.dispose();
  }

  async launch(params: AnyLaunchConfiguration, { targetOrigin }: ILaunchContext): Promise<LaunchResult> {
    if (params.type !== Contributions.ChromeDebugType || params.request !== 'attach')
      return { blockSessionTermination: false };

    this._launchParams = params;
    this._targetOrigin = targetOrigin;
    this._attemptToAttach();
    return { blockSessionTermination: false };
  }

  _scheduleAttach() {
    this._attemptTimer = setTimeout(() => {
      this._attemptTimer = undefined;
      this._attemptToAttach();
    }, 1000);
  }

  async _attemptToAttach() {
    const params = this._launchParams!;
    let connection: CdpConnection | undefined;
    try {
      connection = await launcher.attach({ browserURL: `http://localhost:${params.port}` });
    } catch (e) {
    }
    if (!connection) {
      this._scheduleAttach();
      return;
    }

    if (params.logging && params.logging.cdp)
      connection.setLogConfig(String(params.port || ''), params.logging.cdp);
    this._connection = connection;
    connection.onDisconnected(() => {
      this._connection = undefined;
      if (this._targetManager) {
        this._targetManager.dispose();
        this._targetManager = undefined;
        this._onTargetListChangedEmitter.fire();
      }
      if (this._launchParams)
        this._scheduleAttach();
    }, undefined, this._disposables);

    const pathResolver = new BrowserSourcePathResolver({
      baseUrl: baseURL(params),
      webRoot: params.webRoot || params.rootPath,
      sourceMapOverrides: params.sourceMapPathOverrides,
    });
    this._targetManager = await BrowserTargetManager.connect(connection, pathResolver, this._targetOrigin);
    if (!this._targetManager)
      return;

    this._targetManager.serviceWorkerModel.onDidChange(() => this._onTargetListChangedEmitter.fire());
    this._targetManager.frameModel.onFrameNavigated(() => this._onTargetListChangedEmitter.fire());
    this._targetManager.onTargetAdded((target: BrowserTarget) => {
      this._onTargetListChangedEmitter.fire();
    });
    this._targetManager.onTargetRemoved((target: BrowserTarget) => {
      this._onTargetListChangedEmitter.fire();
    });
    this._targetManager.waitForMainTarget();
  }

  async terminate(): Promise<void> {
    this._launchParams = undefined;
    if (this._connection)
      this._connection.close();
  }

  async disconnect(): Promise<void> {
  }

  async restart(): Promise<void> {
  }

  targetList(): Target[] {
    const manager = this.targetManager();
    return manager ? manager.targetList() : [];
  }
}
