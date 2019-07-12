// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { SourcePathResolver, Location, SourceContainer, Source } from './sources';
import Dap from '../dap/api';
import Cdp from '../cdp/api';
import { Thread, ThreadManager } from './threads';
import * as vscode from 'vscode';

export class Breakpoint {
  private static _lastDapId = 0;
  private _manager: BreakpointManager;
  private _dapId: number;
  private _source: Dap.Source;
  private _params: Dap.SourceBreakpoint;
  private _disposables: vscode.Disposable[] = [];

  private _perThread = new Map<number, Set<string>>();
  private _resolvedUiLocation?: Location;

  constructor(manager: BreakpointManager, source: Dap.Source, params: Dap.SourceBreakpoint) {
    this._dapId = ++Breakpoint._lastDapId;
    this._manager = manager;
    this._source = source;
    this._params = params;
  }

  toDap(): Dap.Breakpoint {
    return {
      id: this._dapId,
      verified: !!this._resolvedUiLocation,
      source: (this._resolvedUiLocation && this._resolvedUiLocation.source) ? this._resolvedUiLocation.source.toDap() : undefined,
      line: this._resolvedUiLocation ? this._resolvedUiLocation.lineNumber : undefined,
      column: this._resolvedUiLocation ? this._resolvedUiLocation.columnNumber : undefined,
    }
  }

  async set(report: boolean): Promise<void> {
    const threadManager = this._manager._threadManager;

    const onBreakpointResolved = (thread: Thread) => {
      thread.cdp().Debugger.on('breakpointResolved', event => this._breakpointResolved(thread, event.breakpointId, [event.location]));
    };
    threadManager.threads().forEach(onBreakpointResolved);
    threadManager.onThreadAdded(onBreakpointResolved, undefined, this._disposables);

    threadManager.onThreadRemoved(thread => {
      this._perThread.delete(thread.threadId());
      if (!this._perThread.size) {
        this._resolvedUiLocation = undefined;
        this._manager._dap.breakpoint({reason: 'changed', breakpoint: this.toDap()});
      }
    }, undefined, this._disposables);

    const source = this._manager._sourceContainer.source(this._source);
    const url = source
      ? source.url() :
      (this._source.path ? this._manager._sourcePathResolver.resolveUrl(this._source.path) : undefined);
    const promises: Promise<void>[] = [];

    if (url) {
      // When url is available, set by url in all threads, including future ones.
      const lineNumber = this._params.line - 1;
      const columnNumber = this._params.column || 0;
      promises.push(...threadManager.threads().map(thread => {
        return this._setByUrl(thread, url, lineNumber, columnNumber);
      }));
      threadManager.onThreadAdded(thread => {
        this._setByUrl(thread, url, lineNumber, columnNumber);
      }, undefined, this._disposables);
    }

    const rawLocations = this._manager._sourceContainer.rawLocations({
      url: url || '',
      lineNumber: this._params.line,
      columnNumber: this._params.column || 1,
      source
    });
    promises.push(...rawLocations.map(rawLocation => this._setByRawLocation(rawLocation)));

    await Promise.all(promises);
    if (report)
      this._manager._dap.breakpoint({reason: 'changed', breakpoint: this.toDap()});
  }

  _breakpointResolved(thread: Thread, cdpId: string, resolvedLocations: Cdp.Debugger.Location[]) {
    if (this._manager._threadManager.thread(thread.threadId()) !== thread)
      return;
    let ids = this._perThread.get(thread.threadId());
    if (!ids) {
      ids = new Set<string>();
      this._perThread.set(thread.threadId(), ids);
    }
    ids.add(cdpId);

    if (this._resolvedUiLocation || !resolvedLocations.length)
      return;
    const rawLocation = thread.locationFromDebugger(resolvedLocations[0]);
    const source = this._manager._sourceContainer.source(this._source);
    if (source)
      this._resolvedUiLocation = this._manager._sourceContainer.uiLocationInSource(rawLocation, source);
  }

  async _setByRawLocation(rawLocation: Location): Promise<void> {
    const threadManager = this._manager._threadManager;
    const promises: Promise<void>[] = [];
    for (const thread of threadManager.threads()) {
      if (rawLocation.url) {
        promises.push(this._setByUrl(thread, rawLocation.url, rawLocation.lineNumber, rawLocation.columnNumber));
      } else if (rawLocation.source) {
        const scripts = this._manager._threadManager.scriptsFromSource(rawLocation.source);
        for (const script of scripts)
          promises.push(this._setByScriptId(script.thread, script.scriptId, rawLocation.lineNumber, rawLocation.columnNumber));
      }
    }
    await Promise.all(promises);
  }

  async _setByUrl(thread: Thread, url: string, lineNumber: number, columnNumber: number): Promise<void> {
    const result = await thread.cdp().Debugger.setBreakpointByUrl({
      url,
      lineNumber,
      columnNumber,
      condition: this._params.condition,
    });
    if (result)
      this._breakpointResolved(thread, result.breakpointId, result.locations);
  }

  async _setByScriptId(thread: Thread, scriptId: string, lineNumber: number, columnNumber: number): Promise<void> {
    const result = await thread.cdp().Debugger.setBreakpoint({
      location: {scriptId, lineNumber, columnNumber},
      condition: this._params.condition,
    });
    if (result)
      this._breakpointResolved(thread, result.breakpointId, [result.actualLocation]);
  }

  async remove(): Promise<void> {
    const promises: Promise<any>[] = [];
    for (const [threadId, ids] of this._perThread) {
      const thread = this._manager._threadManager.thread(threadId)!;
      for (const id of ids)
        promises.push(thread.cdp().Debugger.removeBreakpoint({breakpointId: id}));
    }
    this._resolvedUiLocation = undefined;
    this._perThread.clear();
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables = [];
    await promises;
  }
};

export class BreakpointManager {
  private _byPath: Map<string, Breakpoint[]> = new Map();
  private _byRef: Map<number, Breakpoint[]> = new Map();

  private _initialized = false;
  _dap: Dap.Api;
  _sourcePathResolver: SourcePathResolver;
  _sourceContainer: SourceContainer;
  _threadManager: ThreadManager;

  constructor(dap: Dap.Api, sourcePathResolver: SourcePathResolver, sourceContainer: SourceContainer, threadManager: ThreadManager) {
    this._dap = dap;
    this._sourcePathResolver = sourcePathResolver;
    this._sourceContainer = sourceContainer;
    this._threadManager = threadManager;

    // TODO(dgozman): provide breakpointsHit in paused event.
    // TODO(dgozman): pause on script run to set breakpoints in source maps.
  }

  async initialize(): Promise<void> {
    this._initialized = true;
    const promises: Promise<void>[] = [];
    for (const breakpoints of this._byPath.values())
      promises.push(...breakpoints.map(b => b.set(true)));
    await Promise.all(promises);
  }

  async setBreakpoints(params: Dap.SetBreakpointsParams): Promise<Dap.SetBreakpointsResult | Dap.Error> {
    const breakpoints: Breakpoint[] = (params.breakpoints || []).map(b => new Breakpoint(this, params.source, b));
    let previous: Breakpoint[] | undefined;
    if (params.source.path) {
      previous = this._byPath.get(params.source.path);
      this._byPath.set(params.source.path, breakpoints);
    } else {
      previous = this._byRef.get(params.source.sourceReference!);
      this._byRef.set(params.source.sourceReference!, breakpoints);
    }
    if (previous)
      await Promise.all(previous.map(b => b.remove()));
    if (this._initialized)
      await Promise.all(breakpoints.map(b => b.set(false)));
    return {breakpoints: breakpoints.map(b => b.toDap())};
  }
}
