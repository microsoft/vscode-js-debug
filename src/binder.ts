// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Disposable, EventEmitter } from './common/events';
import { DebugAdapter } from './adapter/debugAdapter';
import { Thread } from './adapter/threads';
import { Launcher, Target } from './targets/targets';
import * as errors from './dap/errors';
import * as urlUtils from './common/urlUtils';
import Dap from './dap/api';
import DapConnection from './dap/connection';
import { generateBreakpointIds } from './adapter/breakpoints';
import { AnyLaunchConfiguration } from './configuration';
import { RawTelemetryReporterToDap } from './telemetry/telemetryReporter';
import { filterErrorsReportedToTelemetry } from './telemetry/unhandledErrorReporter';
import { logger } from './common/logging/logger';
import { resolveLoggerOptions } from './common/logging';

export interface BinderDelegate {
  acquireDap(target: Target): Promise<DapConnection>;
  // Returns whether we should disable child session treatment.
  initAdapter(debugAdapter: DebugAdapter, target: Target): Promise<boolean>;
  releaseDap(target: Target): void;
}

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
  private _launchParams?: AnyLaunchConfiguration;
  private _rawTelemetryReporter: RawTelemetryReporterToDap | undefined;

  constructor(delegate: BinderDelegate, connection: DapConnection, launchers: Launcher[], targetOrigin: any) {
    this._delegate = delegate;
    this._dap = connection.dap();
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

    this._dap.then(dap => {
      this._rawTelemetryReporter = new RawTelemetryReporterToDap(dap);
      dap.on('initialize', async clientCapabilities => {
        const capabilities = DebugAdapter.capabilities();
        if (clientCapabilities.clientID === 'vscode') {
          filterErrorsReportedToTelemetry();
        }

        setTimeout(() => {
          dap.initialized({});
        }, 0);
        return capabilities;
      });
      dap.on('setExceptionBreakpoints', async () => ({}));
      dap.on('setBreakpoints', async params => {
        return { breakpoints: generateBreakpointIds(params).map(id => ({ id, verified: false })) };
      });
      dap.on('configurationDone', async () => ({}));
      dap.on('threads', async () => ({ threads: [] }));
      dap.on('loadedSources', async () => ({ sources: [] }));
      dap.on('attach', async params => {
        await this._boot(params as AnyLaunchConfiguration, dap);
        return {};
      });
      dap.on('launch', async params => {
        await this._boot(params as AnyLaunchConfiguration, dap);
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
        await this._restart(this._rawTelemetryReporter!);
        return {};
      });
    });
  }

  private async _boot(params: AnyLaunchConfiguration, dap: Dap.Api) {
    logger.setup(resolveLoggerOptions(dap, params.trace));

    if (params.rootPath)
      params.rootPath = urlUtils.platformPathToPreferredCase(params.rootPath);
    this._launchParams = params;
    let results = await Promise.all([...this._launchers].map(l => this._launch(l, params)));
    results = results.filter(result => !!result);
    if (results.length)
      return errors.createUserError(results.join('\n'));
    return {};
  }

  async _restart(rawTelemetryReporter: RawTelemetryReporterToDap) {
    await Promise.all([...this._launchers].map(l => l.restart(rawTelemetryReporter)));
  }

  async _launch(launcher: Launcher, params: any): Promise<string | undefined> {
    const result = await launcher.launch(params, { targetOrigin: this._targetOrigin, dap: await this._dap }, this._rawTelemetryReporter!);
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
    const debugAdapter = new DebugAdapter(dap, this._launchParams && this._launchParams.rootPath || undefined, target.sourcePathResolver(), this._launchParams!);
    const thread = debugAdapter.createThread(target.name(), cdp, target);
    this._threads.set(target, {thread, debugAdapter});
    const startThread = async () => {
      await debugAdapter.breakpointManager.launchBlocker();
      cdp.Runtime.runIfWaitingForDebugger({});
      return {};
    };
    if (await this._delegate.initAdapter(debugAdapter, target)) {
      startThread();
    } else {
      dap.on('attach', startThread);
      dap.on('disconnect', async () => {
        this._rawTelemetryReporter!.flush.fire();
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
          await this._restart(this._rawTelemetryReporter!);
        return {};
      });
    }

    await target.afterBind();
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
}
