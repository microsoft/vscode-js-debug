// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import { Adapter } from '../adapter/adapter';
import { Configurator } from '../adapter/configurator';
import * as errors from '../adapter/errors';
import CdpConnection from '../cdp/connection';
import Dap from '../dap/api';
import findChrome from './findChrome';
import * as launcher from './launcher';
import { Target, TargetManager } from './targets';

const localize = nls.loadMessageBundle();

export interface LaunchParams extends Dap.LaunchParams {
  url: string;
  webRoot?: string;
}

export class ChromeAdapter {
  private _dap: Dap.Api;
  private _connection: CdpConnection;
  private _configurator: Configurator;
  private _adapter: Adapter;
  private _storagePath: string;
  private _rootPath: string | undefined;
  private _targetManager: TargetManager;
  private _launchParams: LaunchParams;
  private _mainTarget?: Target;
  private _disposables: vscode.Disposable[] = [];
  private _adapterReadyCallback: (adapter: Adapter) => void;

  static async create(dap: Dap.Api, storagePath: string, rootPath: string | undefined): Promise<Adapter> {
    return new Promise<Adapter>(f => new ChromeAdapter(dap, storagePath, rootPath, f));
  }

  constructor(dap: Dap.Api, storagePath: string, rootPath: string | undefined, adapterReadyCallback: (adapter: Adapter) => void) {
    this._dap = dap;
    this._storagePath = storagePath;
    this._rootPath = rootPath;
    this._adapterReadyCallback = adapterReadyCallback;
    this._configurator = new Configurator(dap);
    this._dap.on('initialize', params => this.initialize(params));
    this._dap.on('configurationDone', params => this.configurationDone(params));
    this._dap.on('launch', params => this._onLaunch(params as LaunchParams));
    this._dap.on('terminate', params => this._onTerminate(params));
    this._dap.on('disconnect', params => this._onDisconnect(params));
    this._dap.on('restart', params => this._onRestart(params));
  }

  targetManager(): TargetManager {
    return this._targetManager;
  }

  adapter(): Adapter {
    return this._adapter;
  }

  connection(): CdpConnection {
    return this._connection;
  }

  async initialize(params: Dap.InitializeParams, isUnderTest?: boolean): Promise<Dap.InitializeResult | Dap.Error> {
    console.assert(params.linesStartAt1);
    console.assert(params.columnsStartAt1);
    console.assert(params.pathFormat === 'path');

    // Prefer canary over stable, it comes earlier in the list.
    const executablePath = findChrome()[0];
    if (!executablePath)
      return errors.createUserError(localize('error.executableNotFound', 'Unable to find Chrome'));
    const args: string[] = [];
    if (isUnderTest) {
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
        userDataDir: path.join(this._storagePath, isUnderTest ? '.headless-profile' : 'profile'),
        pipe: true,
      });
    this._connection.onDisconnected(() => this._dap.exited({ exitCode: 0 }), undefined, this._disposables);
    this._dap.initialized({});
    return this._configurator.capabilities();
  }

  async configurationDone(_: Dap.ConfigurationDoneParams): Promise<Dap.ConfigurationDoneResult> {
    return {};
  }

  async prepareLaunch(params: LaunchParams): Promise<Target | undefined> {
    // params.noDebug
    this._launchParams = params;

    this._adapter = new Adapter(this._dap, this._rootPath, params.url, params.webRoot);
    this._targetManager = new TargetManager(this._connection, this._adapter.threadManager);
    this._adapter.threadManager.setDelegate(this._targetManager);
    await this._adapter.configure(this._configurator);

    // TODO(dgozman): assuming first page is our main target breaks multiple debugging sessions
    // sharing the browser instance.
    this._mainTarget = await this._targetManager.waitForMainTarget();
    if (!this._mainTarget)
      return;
    this._targetManager.onTargetRemoved((target: Target) => {
      if (target === this._mainTarget) {
        this._dap.terminated({});
      }
    });
    return this._mainTarget;
  }

  async finishLaunch(mainTarget: Target): Promise<void> {
    await mainTarget.cdp().Page.navigate({ url: this._launchParams.url });
    this._adapterReadyCallback(this._adapter);
  }

  async _onLaunch(params: LaunchParams): Promise<Dap.LaunchResult | Dap.Error> {
    const mainTarget = await this.prepareLaunch(params);
    if (!mainTarget)
      return errors.createUserError(localize('errors.launchDidFail', 'Unable to launch Chrome'));
    await this.finishLaunch(mainTarget);
    return {};
  }

  _mainTargetNotAvailable(): Dap.Error {
    return errors.createSilentError('Page is not available');
  }

  async _onTerminate(params: Dap.TerminateParams): Promise<Dap.TerminateResult | Dap.Error> {
    if (!this._mainTarget)
      return this._mainTargetNotAvailable();
    this._mainTarget.cdp().Page.navigate({ url: 'about:blank' });
    return {};
  }

  async _onDisconnect(params: Dap.DisconnectParams): Promise<Dap.DisconnectResult | Dap.Error> {
    if (!this._connection)
      return errors.createSilentError('Did not initialize');
    await this._connection.browser().Browser.close({});
    return {};
  }

  async _onRestart(params: Dap.RestartParams): Promise<Dap.RestartResult | Dap.Error> {
    if (!this._mainTarget)
      return this._mainTargetNotAvailable();
    await this._mainTarget.cdp().Page.navigate({ url: this._launchParams.url });
    return {};
  }
}
