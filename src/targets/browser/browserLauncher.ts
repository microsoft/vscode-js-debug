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
import Cdp from '../../cdp/api';
import { BrowserSourcePathResolver } from './browserPathResolver';
import { URL } from 'url';

const localize = nls.loadMessageBundle();

export interface LaunchParams extends Dap.LaunchParams {
  url?: string;
  remoteDebuggingPort?: string;
  baseURL?: string;
  webRoot?: string;
}

export class BrowserLauncher implements Launcher {
  private _connectionForTest: CdpConnection | undefined;
  private _storagePath: string;
  private _rootPath: string | undefined;
  private _targetManager: BrowserTargetManager | undefined;
  private _launchParams: LaunchParams | undefined;
  private _mainTarget?: BrowserTarget;
  private _disposables: vscode.Disposable[] = [];
  private _browserSession: Cdp.Api | undefined;
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

    if (params.remoteDebuggingPort) {
      let c: CdpConnection | undefined;
      for (let i = 0; i < 10; ++i) {
        // Attempt to connect 10 times, 1 second each.
        await new Promise(f => setTimeout(f, 1000));
        try {
          c = await launcher.attach({ browserURL: `http://localhost:${params.remoteDebuggingPort}` });
          break;
        } catch (e) {
        }
      }
      if (!c)
        return errors.createUserError(localize('error.unableToAttachToBrowser', 'Unable to attach to the browser'));
      connection = c;
    } else {
      try {
        connection = await this._launchBrowser(args);
      } catch (e) {
        return errors.createUserError(localize('error.executableNotFound', 'Unable to find browser executable'));
      }
    }

    connection.onDisconnected(() => {
      this._onTerminatedEmitter.fire();
    }, undefined, this._disposables);
    this._connectionForTest = connection;

    const rootSession = connection.rootSession();
    const result = await rootSession.Target.attachToBrowserTarget({});
    if (!result)
      return errors.createUserError(localize('error.unableToAttachToBrowser', 'Unable to attach to the browser'));

    this._browserSession = connection.createSession(result.sessionId);
    this._launchParams = params;

    const pathResolver = new BrowserSourcePathResolver(baseURL(params), params.webRoot || this._rootPath);
    this._targetManager = new BrowserTargetManager(connection, this._browserSession, pathResolver, targetOrigin);
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

  canLaunch(params: any): boolean {
    return 'url' in params || 'remoteDebuggingPort' in params;
  }

  async launch(params: any, targetOrigin: any): Promise<void> {
    if (!this.canLaunch(params))
      return;
    const result = await this.prepareLaunch(params as LaunchParams, [], targetOrigin);
    if (!(result instanceof BrowserTarget))
      return;
    await this.finishLaunch(result);
  }

  _mainTargetNotAvailable(): Dap.Error {
    return errors.createSilentError('Page is not available');
  }

  async terminate(): Promise<void> {
    if (this._mainTarget)
      this._mainTarget.cdp().Page.navigate({ url: 'about:blank' });
  }

  async disconnect(): Promise<void> {
    if (this._browserSession)
      await this._browserSession.Browser.close({});
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

function baseURL(params: LaunchParams): URL | undefined {
  if (params.baseURL) {
    try {
      return new URL(params.baseURL);
    } catch (e) {
    }
  }

  if (params.url) {
    try {
      const baseUrl = new URL(params.url);
      baseUrl.pathname = '/';
      baseUrl.search = '';
      baseUrl.hash = '';
      if (baseUrl.protocol === 'data:')
        return undefined;
      return baseUrl;
    } catch (e) {
    }
  }
}
