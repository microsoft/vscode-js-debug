// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import { Target } from './adapter/targets';
import Dap from './dap/api';
import { DebugAdapterDelegate, DebugAdapter } from './adapter/debugAdapter';
import { Thread, UIDelegate } from './adapter/threads';

export interface Launcher extends vscode.Disposable {
  launch(params: Dap.LaunchParams): Promise<void>;
  terminate(params: Dap.TerminateParams): Promise<void>;
  disconnect(params: Dap.DisconnectParams): Promise<void>;
  restart(params: Dap.RestartParams): Promise<void>;
  onTargetListChanged: vscode.Event<void>;
  onTerminated: vscode.Event<void>;
  targetList(): Target[];
  predictBreakpoints(params: Dap.SetBreakpointsParams): Promise<void>;
}

export class UberAdapter implements vscode.Disposable, DebugAdapterDelegate {
  private _dap: Dap.Api;
  private _onTargetListChangedEmitter = new vscode.EventEmitter<void>();
  private _launchers = new Set<Launcher>();
  readonly onTargetListChanged = this._onTargetListChangedEmitter.event;
  private _disposables: vscode.Disposable[] = [];
  readonly debugAdapter: DebugAdapter;
  private _threads = new Map<Target, Thread>();

  constructor(dap: Dap.Api, uiDelegate: UIDelegate) {
    this._dap = dap;
    this._dap.on('launch', params => this._onLaunch(params));
    this._dap.on('terminate', params => this._onTerminate(params));
    this._dap.on('disconnect', params => this._onDisconnect(params));
    this._dap.on('restart', params => this._onRestart(params));
    this._dap.on('threads', params => this._onThreads(params));
    this.debugAdapter = new DebugAdapter(dap, this, uiDelegate);
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
    launcher.onTargetListChanged(() => {
      const targets = this.targetList()
      this._attachThoseWaitingForDebugger(targets);
      this._detachOrphaneThreads(targets);
      this._onTargetListChangedEmitter.fire();
    }, undefined, this._disposables);

    launcher.onTerminated(() => {
      this._launchers.delete(launcher);
      if (!this._launchers.size)
        this._dap.terminated({});
      this._detachOrphaneThreads(this.targetList());
      this._onTargetListChangedEmitter.fire();
    }, undefined, this._disposables);

    this._onTargetListChangedEmitter.fire();
  }

  targetList(): Target[] {
    const result: Target[] = [];
    for (const delegate of this._launchers)
      result.push(...delegate.targetList());
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

  thread(target: Target): Thread | undefined {
    return this._threads.get(target);
  }

  async attach(target: Target) {
    if (!target.canAttach())
      return;
    const cdp = await target.attach();
    if (!cdp)
      return;
    const thread = this.debugAdapter.threadManager.createThread(target.id(), target.name(), cdp, target);
    thread.initialize();
    this._threads.set(target, thread);
    cdp.Runtime.runIfWaitingForDebugger({});
    this._onTargetListChangedEmitter.fire();
  }

  async detach(target: Target) {
    if (!target.canDetach())
      return;
    await target.detach();
    const thread = this._threads.get(target);
    if (!thread)
      return;
    this._threads.delete(target);
    thread.dispose();
    this._onTargetListChangedEmitter.fire();
  }

  _attachThoseWaitingForDebugger(targets: Target[]) {
    for (const target of targets.values()) {
      if (!target.waitingForDebugger())
        continue;
      const thread = this._threads.get(target);
      if (!thread)
        this.attach(target);
    }
  }

  _detachOrphaneThreads(targets: Target[]) {
    const set = new Set(targets);
    for (const [target, thread] of this._threads) {
      if (!set.has(target)) {
        this._threads.delete(target);
        thread.dispose();
      }
    }
  }
}
