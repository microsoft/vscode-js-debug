// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import { Target } from './adapter/targets';
import Dap from './dap/api';
import { DebugAdapterDelegate } from './adapter/debugAdapter';

export interface Launcher extends vscode.Disposable {
  launch(params: Dap.LaunchParams): Promise<void>;
  terminate(params: Dap.TerminateParams): Promise<void>;
  disconnect(params: Dap.DisconnectParams): Promise<void>;
  restart(params: Dap.RestartParams): Promise<void>;
  onTargetForestChanged: vscode.Event<void>;
  onTerminated: vscode.Event<void>;
  targetForest(): Target[];
  predictBreakpoints(params: Dap.SetBreakpointsParams): Promise<void>;
}

export class UberAdapter implements vscode.Disposable, DebugAdapterDelegate {
  private _dap: Dap.Api;
  private _onTargetForestChangedEmitter = new vscode.EventEmitter<void>();
  private _launchers = new Set<Launcher>();
  readonly onTargetForestChanged = this._onTargetForestChangedEmitter.event;
  private _disposables: vscode.Disposable[] = [];

  constructor(dap: Dap.Api) {
    this._dap = dap;
    this._dap.on('launch', params => this._onLaunch(params));
    this._dap.on('terminate', params => this._onTerminate(params));
    this._dap.on('disconnect', params => this._onDisconnect(params));
    this._dap.on('restart', params => this._onRestart(params));
    this._dap.on('threads', params => this._onThreads(params));
  }

  async _onLaunch(params: Dap.LaunchParams): Promise<Dap.LaunchResult> {
    for (const launcher of this._launchers)
      launcher.launch(params);
    return {};
  }

  async _onTerminate(params: Dap.TerminateParams): Promise<Dap.TerminateResult> {
    for (const launcher of this._launchers)
      launcher.terminate(params);
    return {};
  }

  async _onDisconnect(params: Dap.DisconnectParams): Promise<Dap.DisconnectResult> {
    for (const launcher of this._launchers)
      launcher.disconnect(params);
    return {};
  }

  async _onRestart(params: Dap.RestartParams): Promise<Dap.RestartResult> {
    for (const launcher of this._launchers)
      launcher.restart(params);
    return {};
  }

  async _onThreads(params: Dap.ThreadsParams): Promise<Dap.ThreadsResult> {
    return {threads: []};
  }

  addLauncher(launcher: Launcher) {
    this._launchers.add(launcher);
    launcher.onTargetForestChanged(() => {
      this._onTargetForestChangedEmitter.fire();
    }, undefined, this._disposables);

    launcher.onTerminated(() => {
      this._launchers.delete(launcher);
      if (!this._launchers.size)
        this._dap.terminated({});
      this._onTargetForestChangedEmitter.fire();
    }, undefined, this._disposables);

    this._onTargetForestChangedEmitter.fire();
  }

  targetForest(): Target[] {
    const result: Target[] = [];
    for (const delegate of this._launchers)
      result.push(...delegate.targetForest());
    return result;
  }

  dispose() {
    for (const launcher of this._launchers)
      launcher.dispose();
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables = [];
  }

  async onSetBreakpoints(params: Dap.SetBreakpointsParams): Promise<void> {
    for (const launcher of this._launchers)
      await launcher.predictBreakpoints(params);
  }
}
