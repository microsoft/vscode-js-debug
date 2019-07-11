/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {LaunchParams, SourcePathResolver, Location, SourceContainer} from './source';
import Dap from '../dap/api';
import {TargetManager} from './targetManager';
import Cdp from '../cdp/api';
import {Thread} from './thread';

type SetResult = {
  id: string;
  resolved: Cdp.Debugger.Location[];
};

export class Breakpoint {
  private static _lastDapId = 0;
  private _manager: BreakpointManager;
  private _dapId: number;
  private _source: Dap.Source;
  private _params: Dap.SourceBreakpoint;

  private _perThread = new Map<number, string[]>();
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
    const source = this._manager._sourceContainer.source(this._source);
    let url: string | undefined;
    if (!source) {
      if (!this._source.path)
        return;
      url = this._manager._sourcePathResolver.resolveUrl(this._source.path);
    } else if (!source.url()) {
      if (this._source.path)
        url = this._manager._sourcePathResolver.resolveUrl(this._source.path);
    } else {
      url = source.url();
    }
    await this._set({
      lineNumber: this._params.line,
      columnNumber: this._params.column || 1,
      url: url || '',
      source
    });
    if (report)
      this._manager._dap.breakpoint({reason: 'changed', breakpoint: this.toDap()});
  }

  async _set(uiLocation: Location): Promise<void> {
    this._resolvedUiLocation = undefined;
    const rawLocations = this._manager._sourceContainer.rawLocations(uiLocation);
    const promises = rawLocations.map(rawLocation => this._setInThreads(rawLocation));
    await Promise.all(promises);
  }

  async _setInThreads(rawLocation: Location): Promise<void> {
    const targetManager = this._manager._targetManager;
    const promises: Promise<void>[] = [];
    for (const [threadId, thread] of targetManager.threads) {
      const promise = rawLocation.url ? this._setByUrl(thread, rawLocation) : this._setByScriptId(thread, rawLocation);
      promises.push(promise.then(result => {
        if (!result || targetManager.threads.get(threadId) !== thread)
          return;
        let ids = this._perThread.get(threadId);
        if (!ids) {
          ids = [];
          this._perThread.set(threadId, ids);
        }
        ids.push(result.id);
        this._updateResolvedLocation(thread, result.resolved);
      }));
    }
    await Promise.all(promises);
  }

  async _setByUrl(thread: Thread, rawLocation: Location): Promise<SetResult | undefined> {
    const result = await thread.cdp().Debugger.setBreakpointByUrl({
      url: rawLocation.url,
      lineNumber: rawLocation.lineNumber,
      columnNumber: rawLocation.columnNumber,
      condition: this._params.condition,
    });
    if (result)
      return {id: result.breakpointId, resolved: result.locations};
  }

  async _setByScriptId(thread: Thread, rawLocation: Location): Promise<SetResult | undefined> {
    const result = await thread.cdp().Debugger.setBreakpoint({
      location: {
        // TODO(dgozman): get script id.
        scriptId: '',
        lineNumber: rawLocation.lineNumber,
        columnNumber: rawLocation.columnNumber,
      },
      condition: this._params.condition,
    });
    if (result)
      return {id: result.breakpointId, resolved: [result.actualLocation]};
  }

  async remove(): Promise<void> {
    const promises: Promise<any>[] = [];
    for (const [threadId, ids] of this._perThread) {
      const thread = this._manager._targetManager.threads.get(threadId)!;
      for (const id of ids)
        promises.push(thread.cdp().Debugger.removeBreakpoint({breakpointId: id}));
    }
    this._resolvedUiLocation = undefined;
    this._perThread.clear();
    await promises;
  }

  _updateResolvedLocation(thread: Thread, locations: Cdp.Debugger.Location[]) {
    if (this._resolvedUiLocation || !locations.length)
      return;
    const rawLocation = thread.locationFromDebugger(locations[0]);
    this._resolvedUiLocation = this._manager._sourceContainer.uiLocation(rawLocation);
  }
};

export class BreakpointManager {
  private _byPath: Map<string, Breakpoint[]> = new Map();
  private _byRef: Map<number, Breakpoint[]> = new Map();

  private _launchParams?: LaunchParams;
  _dap: Dap.Api;
  _sourcePathResolver: SourcePathResolver;
  _sourceContainer: SourceContainer;
  _targetManager: TargetManager;

  constructor(dap: Dap.Api, sourcePathResolver: SourcePathResolver, sourceContainer: SourceContainer, targetManager: TargetManager) {
    this._dap = dap;
    this._sourcePathResolver = sourcePathResolver;
    this._sourceContainer = sourceContainer;
    this._targetManager = targetManager;

    // TODO(dgozman): listen to Debugger.breakpointsResolved on each thread.
    // TODO(dgozman): put new breakpoints in onThreadAdded, cleanup in onThreadRemoved.
    // TODO(dgozman): provide breakpointsHit in paused event.
    // TODO(dgozman): pause on script run to set breakpoints in source maps.
    // TODO(dgozman): update breakpoints if source map source with matching path arrives.
  }

  async initialize(launchParams: LaunchParams): Promise<void> {
    this._launchParams = launchParams;
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
    if (this._launchParams)
      await Promise.all(breakpoints.map(b => b.set(false)));
    return {breakpoints: breakpoints.map(b => b.toDap())};
  }
}
