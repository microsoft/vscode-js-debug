/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Dap from '../dap/api';

import CdpConnection from '../cdp/connection';
import { Target, TargetManager } from './targets';
import findChrome from './findChrome';
import * as launcher from './launcher';
import * as path from 'path';
import * as fs from 'fs';
import * as nls from 'vscode-nls';
import * as errors from '../adapter/errors';
import * as vscode from 'vscode';
import { Adapter } from '../adapter/adapter';

const localize = nls.loadMessageBundle();

export interface ConfigurationDoneResult extends Dap.ConfigurationDoneResult {
  targetId?: string;
}

export interface LaunchParams extends Dap.LaunchParams {
  url: string;
  webRoot?: string;
}

export class ChromeAdapter {
  private _dap: Dap.Api;
  private _connection: CdpConnection;
  private _adapter: Adapter;
  private _storagePath: string;
  private _initializeParams: Dap.InitializeParams;
  private _targetManager: TargetManager;
  private _launchParams: LaunchParams;
  private _mainTarget?: Target;
  private _disposables: vscode.Disposable[] = [];
  private _adapterReadyCallback: (adapter: Adapter) => void;

  static async create(dap: Dap.Api, storagePath: string): Promise<Adapter> {
    return new Promise<Adapter>(f => new ChromeAdapter(dap, storagePath, f));
  }

  constructor(dap: Dap.Api, storagePath: string, adapterReadyCallback: (adapter: Adapter) => void) {
    this._dap = dap;
    this._storagePath = storagePath;
    this._adapterReadyCallback = adapterReadyCallback;
    this._dap.on('initialize', params => this._onInitialize(params));
    this._dap.on('configurationDone', params => this._onConfigurationDone(params));
    this._dap.on('launch', params => this._onLaunch(params as LaunchParams));
    this._dap.on('terminate', params => this._onTerminate(params));
    this._dap.on('disconnect', params => this._onDisconnect(params));
    this._dap.on('restart', params => this._onRestart(params));
  }

  testConnection(): Promise<CdpConnection> {
    return this._connection.clone();
  }

  targetManager(): TargetManager {
    return this._targetManager;
  }

  adapter(): Adapter {
    return this._adapter;
  }

  _isUnderTest(): boolean {
    return this._initializeParams.clientID === 'cdp-test';
  }

  async _onInitialize(params: Dap.InitializeParams): Promise<Dap.InitializeResult | Dap.Error> {
    this._initializeParams = params;
    console.assert(params.linesStartAt1);
    console.assert(params.columnsStartAt1);
    console.assert(params.pathFormat === 'path');

    // Prefer canary over stable, it comes earlier in the list.
    const executablePath = findChrome()[0];
    if (!executablePath)
      return errors.createUserError(localize('error.executableNotFound', 'Unable to find Chrome'));
    const args: string[] = [];
    if (this._isUnderTest()) {
      args.push('--remote-debugging-port=0');
      args.push('--headless');
    }

    try {
      fs.mkdirSync(this._storagePath);
    } catch (e) {
    }
    this._connection = await launcher.launch(
      executablePath, {
        args,
        userDataDir: path.join(this._storagePath, this._isUnderTest() ? '.headless-profile' : 'profile'),
        pipe: true,
      });
    this._connection.onDisconnected(() => this._dap.exited({exitCode: 0}), undefined, this._disposables);
    this._adapter = new Adapter(this._dap, () => {
      return this._targetManager.executionContexts();
    });
    this._targetManager = new TargetManager(this._connection, this._adapter.threadManager);
    this._dap.initialized({});
    return Adapter.capabilities();
  }

  async _onConfigurationDone(params: Dap.ConfigurationDoneParams): Promise<ConfigurationDoneResult> {
    // TODO(dgozman): assuming first page is our main target breaks multiple debugging sessions
    // sharing the browser instance.
    this._mainTarget = this._targetManager.mainTarget();
    if (!this._mainTarget)
      this._mainTarget = await new Promise(f => this._targetManager.onTargetAdded(f)) as Target;
    this._targetManager.onTargetRemoved((target: Target) => {
      if (target === this._mainTarget) {
        this._dap.terminated({});
      }
    });
    if (this._isUnderTest())
      return {targetId: this._mainTarget.targetId()};
    return {};
  }

  async _onLaunch(params: LaunchParams): Promise<Dap.LaunchResult> {
    if (!this._mainTarget)
      await this._onConfigurationDone({});

    // params.noDebug
    this._launchParams = params;
    this._adapter.launch(params.url, params.webRoot);
    await this._mainTarget!.cdp().Page.navigate({url: params.url});
    this._adapterReadyCallback(this._adapter);
    return {};
  }

  _mainTargetNotAvailable(): Dap.Error {
    return errors.createSilentError('Page is not available');
  }

  async _onTerminate(params: Dap.TerminateParams): Promise<Dap.TerminateResult | Dap.Error> {
    if (!this._mainTarget)
      return this._mainTargetNotAvailable();
    this._mainTarget.cdp().Page.navigate({url: 'about:blank'});
    return {};
  }

  async _onDisconnect(params: Dap.DisconnectParams): Promise<Dap.DisconnectResult | Dap.Error> {
    if (!this._targetManager)
      return this._mainTargetNotAvailable();
    await this._connection.browser().Browser.close({});
    return {};
  }

  async _onRestart(params: Dap.RestartParams): Promise<Dap.RestartResult | Dap.Error> {
    if (!this._mainTarget)
      return this._mainTargetNotAvailable();
    await this._mainTarget.cdp().Page.navigate({url: this._launchParams.url});
    return {};
  }
}
