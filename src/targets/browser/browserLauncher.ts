// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import * as errors from '../../dap/errors';
import CdpConnection from '../../cdp/connection';
import Dap from '../../dap/api';
import findBrowser from './findBrowser';
import * as launcher from './launcher';
import { BrowserTarget, BrowserTargetManager } from './browserTargets';
import { Target, Launcher } from '../../targets/targets';
import { BrowserSourcePathResolver } from './browserPathResolver';
import { LaunchParams, baseURL } from './browserLaunchParams';

const localize = nls.loadMessageBundle();

export class BrowserLauncher implements Launcher {
  private _connectionForTest: CdpConnection | undefined;
  private _storagePath: string;
  private _rootPath: string | undefined;
  private _targetManager: BrowserTargetManager | undefined;
  private _launchParams: LaunchParams | undefined;
  private _mainTarget?: BrowserTarget;
  private _disposables: vscode.Disposable[] = [];
  private _onTerminatedEmitter = new vscode.EventEmitter<void>();
  readonly onTerminated = this._onTerminatedEmitter.event;
  private _onTargetListChangedEmitter = new vscode.EventEmitter<void>();
  readonly onTargetListChanged = this._onTargetListChangedEmitter.event;

  constructor(storagePath: string, rootPath: string | undefined) {
    this._storagePath = storagePath;
    this._rootPath = rootPath;
  }

  targetManager(): BrowserTargetManager | undefined {
    return this._targetManager;
  }

  dispose() {
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables = [];
  }

  async _launchBrowser(args: string[]): Promise<CdpConnection> {
    // Prefer canary over stable, it comes earlier in the list.
    const executablePath = findBrowser()[0];
    if (!executablePath)
      throw new Error('Unable to find browser');

    try {
      fs.mkdirSync(this._storagePath);
    } catch (e) {
    }
    return await launcher.launch(
      executablePath, {
        args,
        userDataDir: path.join(this._storagePath, args.indexOf('--headless') !== -1 ? '.headless-profile' : '.profile'),
        pipe: true,
      });
  }

  async prepareLaunch(params: LaunchParams, args: string[], targetOrigin: any): Promise<BrowserTarget | Dap.Error> {
    let connection: CdpConnection;
    try {
      connection = await this._launchBrowser(args);
    } catch (e) {
      return errors.createUserError(localize('error.executableNotFound', 'Unable to find browser executable'));
    }

    connection.onDisconnected(() => {
      this._onTerminatedEmitter.fire();
    }, undefined, this._disposables);
    this._connectionForTest = connection;
    this._launchParams = params;

    const pathResolver = new BrowserSourcePathResolver(baseURL(params), params.webRoot || this._rootPath);
    this._targetManager = await BrowserTargetManager.connect(connection, pathResolver, targetOrigin);
    if (!this._targetManager)
      return errors.createUserError(localize('error.unableToAttachToBrowser', 'Unable to attach to the browser'));

    this._targetManager.serviceWorkerModel.onDidChange(() => this._onTargetListChangedEmitter.fire());
    this._targetManager.frameModel.onFrameNavigated(() => this._onTargetListChangedEmitter.fire());
    this._disposables.push(this._targetManager);

    this._targetManager.onTargetAdded((target: BrowserTarget) => {
      this._onTargetListChangedEmitter.fire();
    });
    this._targetManager.onTargetRemoved((target: BrowserTarget) => {
      this._onTargetListChangedEmitter.fire();
    });

    // Note: assuming first page is our main target breaks multiple debugging sessions
    // sharing the browser instance. This can be fixed.
    this._mainTarget = await this._targetManager.waitForMainTarget();
    if (!this._mainTarget)
      return errors.createSilentError(localize('error.threadNotFound', 'Thread not found'));
    this._targetManager.onTargetRemoved((target: BrowserTarget) => {
      if (target === this._mainTarget)
        this._onTerminatedEmitter.fire();
    });
    return this._mainTarget;
  }

  async finishLaunch(mainTarget: BrowserTarget): Promise<void> {
    if (this._launchParams!.url)
      await mainTarget.cdp().Page.navigate({ url: this._launchParams!.url });
  }

  async launch(params: any, targetOrigin: any): Promise<boolean> {
    if (!('url' in params))
      return false;
    const result = await this.prepareLaunch(params as LaunchParams, [], targetOrigin);
    if (!(result instanceof BrowserTarget))
      return false;
    await this.finishLaunch(result);
    return true;  // Block session on termination.
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
