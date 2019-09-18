// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Disposable, EventEmitter } from '../../utils/eventUtils';
import CdpConnection from '../../cdp/connection';
import * as launcher from './launcher';
import { BrowserTarget, BrowserTargetManager } from './browserTargets';
import { Target, Launcher } from '../targets';
import { BrowserSourcePathResolver } from './browserPathResolver';
import { baseURL, LaunchParams } from './browserLaunchParams';

export class BrowserAttacher implements Launcher {
  private _rootPath: string | undefined;
  private _attemptTimer: NodeJS.Timer | undefined;
  private _connection: CdpConnection | undefined;
  private _targetManager: BrowserTargetManager | undefined;
  private _launchParams: LaunchParams | undefined;
  private _targetOrigin: any;
  private _disposables: Disposable[] = [];
  private _onTerminatedEmitter = new EventEmitter<void>();
  readonly onTerminated = this._onTerminatedEmitter.event;
  private _onTargetListChangedEmitter = new EventEmitter<void>();
  readonly onTargetListChanged = this._onTargetListChangedEmitter.event;

  constructor(rootPath: string | undefined) {
    this._rootPath = rootPath;
  }

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

  async launch(params: any, targetOrigin: any): Promise<boolean> {
    if (!('remoteDebuggingPort' in params))
      return false;

    this._launchParams = params;
    this._targetOrigin = targetOrigin;
    this._attemptToAttach();
    return false;  // Do not block session on termination.
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
      connection = await launcher.attach({ browserURL: `http://localhost:${params.remoteDebuggingPort}` });
    } catch (e) {
    }
    if (!connection) {
      this._scheduleAttach();
      return;
    }

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

    const pathResolver = new BrowserSourcePathResolver(baseURL(params), params.webRoot || this._rootPath);
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
