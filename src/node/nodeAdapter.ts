/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Dap from '../dap/api';
import CdpConnection from '../cdp/connection';
import { Adapter } from '../adapter/adapter';
import * as vscode from 'vscode';
import * as child_process from 'child_process';

export interface LaunchParams extends Dap.LaunchParams {
  program: string;
  runtime: string;
}

export class NodeAdapter {
  private _dap: Dap.Api;
  private _connection: CdpConnection;
  private _adapter: Adapter;
  private _disposables: vscode.Disposable[] = [];
  private _adapterReadyCallback: (adapter: Adapter) => void;

  static async create(dap: Dap.Api): Promise<Adapter> {
    return new Promise<Adapter>(f => new NodeAdapter(dap, f));
  }

  constructor(dap: Dap.Api, adapterReadyCallback: (adapter: Adapter) => void) {
    this._dap = dap;
    this._adapterReadyCallback = adapterReadyCallback;
    this._dap.on('initialize', params => this._onInitialize(params));
    this._dap.on('configurationDone', params => this._onConfigurationDone(params));
    this._dap.on('launch', params => this._onLaunch(params as LaunchParams));
    this._dap.on('terminate', params => this._onTerminate(params));
    this._dap.on('disconnect', params => this._onDisconnect(params));
    this._dap.on('restart', params => this._onRestart(params));
  }

  async _onInitialize(params: Dap.InitializeParams): Promise<Dap.InitializeResult | Dap.Error> {
    console.assert(params.linesStartAt1);
    console.assert(params.columnsStartAt1);
    return Adapter.capabilities();
  }

  async _onConfigurationDone(params: Dap.ConfigurationDoneParams): Promise<Dap.ConfigurationDoneResult> {
    // TODO(dgozman): assuming first page is our main target breaks multiple debugging sessions
    // sharing the browser instance.
    return {};
  }

  async _onLaunch(params: LaunchParams): Promise<Dap.LaunchResult> {
    // params.noDebug
    // TODO(pfeldman): set up IPC for Ndd.
    this._connection.onDisconnected(() => this._dap.exited({exitCode: 0}), undefined, this._disposables);
    this._adapter = new Adapter(this._dap, () => { return []; });
    this._dap.initialized({});
    this._adapterReadyCallback(this._adapter);
    return {};

    this._adapter.launch('', '');
    return {};
  }

  async _onTerminate(params: Dap.TerminateParams): Promise<Dap.TerminateResult | Dap.Error> {
    return {};
  }

  async _onDisconnect(params: Dap.DisconnectParams): Promise<Dap.DisconnectResult | Dap.Error> {
    return {};
  }

  async _onRestart(params: Dap.RestartParams): Promise<Dap.RestartResult | Dap.Error> {
    return {};
  }
}
