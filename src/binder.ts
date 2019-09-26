// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Disposable, EventEmitter } from './utils/eventUtils';
import { DebugAdapter } from './adapter/debugAdapter';
import { Thread } from './adapter/threads';
import { Launcher, Target } from './targets/targets';
import * as errors from './dap/errors';

export interface BinderDelegate {
  acquireDebugAdapter(target: Target): Promise<DebugAdapter>;
  releaseDebugAdapter(target: Target, debugAdapter: DebugAdapter): void;
}

export class Binder implements Disposable {
  private _delegate: BinderDelegate;
  private _disposables: Disposable[];
  private _threads = new Map<Target, {thread: Thread, debugAdapter: DebugAdapter}>();
  private _launchers = new Set<Launcher>();
  private _terminationCount = 0;
  private _onTargetListChangedEmitter = new EventEmitter<void>();
  readonly onTargetListChanged = this._onTargetListChangedEmitter.event;
  private _debugAdapter: DebugAdapter;
  private _targetOrigin: any;

  constructor(delegate: BinderDelegate, debugAdapter: DebugAdapter, launchers: Launcher[], targetOrigin: any) {
    this._delegate = delegate;
    this._debugAdapter = debugAdapter;
    this._targetOrigin = targetOrigin;
    this._disposables = [this._onTargetListChangedEmitter];

    for (const launcher of launchers) {
      this._launchers.add(launcher);
      launcher.onTargetListChanged(() => {
        const targets = this.targetList();
        this._attachToNewTargets(targets);
        this._detachOrphaneThreads(targets);
        this._onTargetListChangedEmitter.fire();
      }, undefined, this._disposables);
    }

    debugAdapter.dap.on('launch', async params => {
      let results = await Promise.all(launchers.map(l => this._launch(l, params)));
      results = results.filter(result => !!result);
      if (results.length)
        return errors.createUserError(results.join('\n'));
      return {};
    });
    debugAdapter.dap.on('terminate', async () => {
      await Promise.all([...this._launchers].map(l => l.terminate()));
      return {};
    });
    debugAdapter.dap.on('disconnect', async () => {
      await Promise.all([...this._launchers].map(l => l.disconnect()));
      return {};
    });
    debugAdapter.dap.on('restart', async () => {
      await this._restart();
      return {};
    });
  }

  async _restart() {
    await Promise.all([...this._launchers].map(l => l.restart()));
  }

  async _launch(launcher: Launcher, params: any): Promise<string | undefined> {
    const result = await launcher.launch(params, this._targetOrigin);
    if (result.error)
      return result.error;
    if (result.blockSessionTermination)
      this._listenToTermination(launcher);
  }

  considerLaunchedForTest(launcher: Launcher) {
    this._listenToTermination(launcher);
  }

  _listenToTermination(launcher: Launcher) {
    ++this._terminationCount;
    launcher.onTerminated(() => {
      this._launchers.delete(launcher);
      this._detachOrphaneThreads(this.targetList());
      this._onTargetListChangedEmitter.fire();
      --this._terminationCount;
      if (!this._terminationCount)
        this._debugAdapter.dap.terminated({});
    }, undefined, this._disposables);
  }

  dispose() {
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables = [];
    for (const launcher of this._launchers)
      launcher.dispose();
    this._launchers.clear();
    this._detachOrphaneThreads([]);
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
    await debugAdapter.launchBlocker();
    if (debugAdapter !== this._debugAdapter) {
      debugAdapter.dap.on('disconnect', async () => {
        if (target.canStop())
          target.stop();
        return {};
      });
      debugAdapter.dap.on('terminate', async () => {
        if (target.canStop())
          target.stop();
        return {};
      });
      debugAdapter.dap.on('restart', async () => {
        if (target.canRestart())
          target.restart();
        else
          await this._restart();
        return {};
      });
    }
    const thread = debugAdapter.createThread(target.name(), cdp, target);
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
    this._delegate.releaseDebugAdapter(target, data.debugAdapter);
  }

  _attachToNewTargets(targets: Target[]) {
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
        this._delegate.releaseDebugAdapter(target, data.debugAdapter);
      }
    }
  }
}
