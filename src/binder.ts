// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Disposable, EventEmitter } from './common/events';
import { DebugAdapter } from './adapter/debugAdapter';
import { Thread } from './adapter/threads';
import { Launcher, Target } from './targets/targets';
import * as errors from './dap/errors';
import Dap from './dap/api';
import DapConnection from './dap/connection';

export interface BinderDelegate {
  acquireDap(target: Target): Promise<DapConnection>;
  releaseDap(target: Target): void;
}

type TestHook = (target: Target, adapter: DebugAdapter) => void;

export class Binder implements Disposable {
  private _delegate: BinderDelegate;
  private _disposables: Disposable[];
  private _threads = new Map<Target, {thread: Thread, debugAdapter: DebugAdapter}>();
  private _launchers = new Set<Launcher>();
  private _terminationCount = 0;
  private _onTargetListChangedEmitter = new EventEmitter<void>();
  readonly onTargetListChanged = this._onTargetListChangedEmitter.event;
  private _dap: Promise<Dap.Api>;
  private _targetOrigin: any;
  private _rootPath?: string;
  private _testHook?: TestHook;

  constructor(delegate: BinderDelegate, connection: DapConnection, launchers: Launcher[], rootPath: string | undefined, targetOrigin: any) {
    this._delegate = delegate;
    this._dap = connection.dap();
    this._targetOrigin = targetOrigin;
    this._rootPath = rootPath;
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

    this._dap.then(dap => {
      dap.on('initialize', async () => {
        dap.initialized({});
        return DebugAdapter.capabilities();
      });
      dap.on('configurationDone', async () => {
        return {};
      });
      dap.on('launch', async params => {
        let results = await Promise.all(launchers.map(l => this._launch(l, params)));
        results = results.filter(result => !!result);
        if (results.length)
          return errors.createUserError(results.join('\n'));
        return {};
      });
      dap.on('terminate', async () => {
        await Promise.all([...this._launchers].map(l => l.terminate()));
        return {};
      });
      dap.on('disconnect', async () => {
        await Promise.all([...this._launchers].map(l => l.disconnect()));
        return {};
      });
      dap.on('restart', async () => {
        await this._restart();
        return {};
      });
    });
  }

  async _restart() {
    await Promise.all([...this._launchers].map(l => l.restart()));
  }

  async _launch(launcher: Launcher, params: any): Promise<string | undefined> {
    const result = await launcher.launch(params, this._targetOrigin);
    if (result.error)
      return result.error;
    if (!result.blockSessionTermination)
      return;
    ++this._terminationCount;
    launcher.onTerminated(() => {
      this._launchers.delete(launcher);
      this._detachOrphaneThreads(this.targetList());
      this._onTargetListChangedEmitter.fire();
      --this._terminationCount;
      if (!this._terminationCount)
        this._dap.then(dap => dap.terminated({}));
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
    const connection = await this._delegate.acquireDap(target);
    const dap = await connection.dap();
    const debugAdapter = new DebugAdapter(dap, this._rootPath, target.sourcePathResolver());
    const thread = debugAdapter.createThread(target.name(), cdp, target);
    this._threads.set(target, {thread, debugAdapter});
    dap.on('attach', async () => {
      await debugAdapter.launchBlocker();
      cdp.Runtime.runIfWaitingForDebugger({});
      return {};
    });
    dap.on('disconnect', async () => {
      if (target.canStop())
        target.stop();
      return {};
    });
    dap.on('terminate', async () => {
      if (target.canStop())
        target.stop();
      return {};
    });
    dap.on('restart', async () => {
      if (target.canRestart())
        target.restart();
      else
        await this._restart();
      return {};
    });
    if (this._testHook)
      this._testHook(target, debugAdapter);
  }

  async detach(target: Target) {
    if (!target.canDetach())
      return;
    await target.detach();
    this._releaseTarget(target);
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
    for (const target of this._threads.keys()) {
      if (!set.has(target))
        this._releaseTarget(target);
    }
  }

  _releaseTarget(target: Target) {
    const data = this._threads.get(target);
    if (!data)
      return;
    this._threads.delete(target);
    data.thread.dispose();
    data.debugAdapter.dap.terminated({});
    data.debugAdapter.dispose();
    this._delegate.releaseDap(target);
  }

  installTestHook(hook: TestHook) {
    this._testHook = hook;
  }
}
