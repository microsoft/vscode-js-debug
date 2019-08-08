// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Disposable, EventEmitter } from 'vscode';
import { DebugAdapter } from './adapter/debugAdapter';
import { Thread } from './adapter/threads';
import { Launcher, Target } from './targets/targets';

export interface BinderDelegate {
  acquireDebugAdapter(target: Target): Promise<DebugAdapter>;
  releaseDebugAdapter(debugAdapter: DebugAdapter): void;
}

export class Binder implements Disposable {
  private _delegate: BinderDelegate;
  private _disposables: Disposable[];
  private _threads = new Map<Target, {thread: Thread, debugAdapter: DebugAdapter}>();
  private _launchers = new Set<Launcher>();
  private _onTargetListChangedEmitter = new EventEmitter<void>();
  readonly onTargetListChanged = this._onTargetListChangedEmitter.event;

  constructor(delegate: BinderDelegate, debugAdapter: DebugAdapter, launchers: Launcher[], targetOrigin: any) {
    this._delegate = delegate;
    this._disposables = [this._onTargetListChangedEmitter];

    for (const launcher of launchers) {
      this._launchers.add(launcher);
      launcher.onTerminated(() => {
        this._launchers.delete(launcher);
        this._detachOrphaneThreads(this.targetList());
        this._onTargetListChangedEmitter.fire();
        if (!this._launchers.size)
          debugAdapter.dap.terminated({});
      }, undefined, this._disposables);

      launcher.onTargetListChanged(() => {
        const targets = this.targetList();
        this._attachThoseWaitingForDebugger(targets);
        this._detachOrphaneThreads(targets);
        this._onTargetListChangedEmitter.fire();
      }, undefined, this._disposables);
    }

    debugAdapter.dap.on('launch', async params => {
      await debugAdapter.breakpointManager.launchBlocker();
      for (const launcher of this._launchers)
        await launcher.launch(params, targetOrigin);
      return {};
    });
    debugAdapter.dap.on('terminate', async () => {
      for (const launcher of this._launchers)
        await launcher.terminate();
      return {};
    });
    debugAdapter.dap.on('disconnect', async () => {
      for (const launcher of this._launchers)
        await launcher.disconnect();
      return {};
    });
    debugAdapter.dap.on('restart', async () => {
      for (const launcher of this._launchers)
        await launcher.restart();
      return {};
    });
  }

  dispose() {
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables = [];
  }

  debugAdapter(target: Target): DebugAdapter | undefined {
    const data = this._threads.get(target);
    return data && data.debugAdapter;
  }

  thread(target: Target): Thread | undefined {
    const data = this._threads.get(target);
    return data && data.thread;
  }

  targetList(): Target[] {
    const result: Target[] = [];
    for (const delegate of this._launchers)
      result.push(...delegate.targetList());
    return result;
  }

  async attach(target: Target) {
    if (!target.canAttach())
      return;
    const cdp = await target.attach();
    if (!cdp)
      return;
    const debugAdapter = await this._delegate.acquireDebugAdapter(target);
    const thread = debugAdapter.threadManager.createThread(target.id(), target.name(), cdp, target);
    thread.initialize();
    this._threads.set(target, {thread, debugAdapter});
    cdp.Runtime.runIfWaitingForDebugger({});
  }

  async detach(target: Target) {
    if (!target.canDetach())
      return;
    await target.detach();
    const data = this._threads.get(target);
    if (!data)
      return;
    this._threads.delete(target);
    data.thread.dispose();
    this._delegate.releaseDebugAdapter(data.debugAdapter);
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
    for (const [target, data] of this._threads) {
      if (!set.has(target)) {
        this._threads.delete(target);
        data.thread.dispose();
        this._delegate.releaseDebugAdapter(data.debugAdapter);
      }
    }
  }
}
