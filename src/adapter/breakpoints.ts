/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Location, SourceContainer, Source } from './sources';
import Dap from '../dap/api';
import Cdp from '../cdp/api';
import { Thread, ThreadManager, Script } from './threads';
import { Disposable } from 'vscode';

export class Breakpoint {
  private _manager: BreakpointManager;
  private _dapId: number;
  private _source: Dap.Source;
  private _condition?: string;
  private _lineNumber: number;  // 1-based
  private _columnNumber: number;  // 1-based
  private _disposables: Disposable[] = [];
  private _activeSetters = new Set<Promise<void>>();

  private _perThread = new Map<string, Set<Cdp.Debugger.BreakpointId>>();
  private _resolvedLocation?: Location;

  constructor(manager: BreakpointManager, dapId: number, source: Dap.Source, params: Dap.SourceBreakpoint) {
    this._manager = manager;
    this._dapId = dapId;
    this._source = source;
    this._lineNumber = params.line;
    this._columnNumber = params.column || 1;
    if (params.logMessage)
      this._condition = logMessageToExpression(params.logMessage);
    if (params.condition)
      this._condition = this._condition ? `(${params.condition}) && ${this._condition}` : params.condition;
  }

  toProvisionalDap(): Dap.Breakpoint {
    return {
      id: this._dapId,
      verified: false
    };
  }

  async _notifyResolved(): Promise<void> {
    if (!this._resolvedLocation)
      return;
    this._manager._dap.breakpoint({
      reason: 'changed',
      breakpoint: {
        id: this._dapId,
        verified: true,
        source: this._resolvedLocation.source ? await this._resolvedLocation.source.toDap() : undefined,
        line: this._resolvedLocation.lineNumber,
        column: this._resolvedLocation.columnNumber
      }
    });
  }

  async set(): Promise<void> {
    // General strategy:
    // 1. Set all breakpoints by original url if any.
    // 2. Resolve and set to all locations immediately. This covers breakpoints
    //    in scripts without urls, which are set by script id.
    // 3. When new script with source map arrives, resolve all breakpoints in source map sources
    //    and apply them to this particular script. See setScriptSourceMapHandler.
    const threadManager = this._manager._threadManager;
    threadManager.onThreadRemoved(thread => {
      this._perThread.delete(thread.threadId());
      if (!this._perThread.size) {
        this._resolvedLocation = undefined;
        this._manager._dap.breakpoint({ reason: 'changed', breakpoint: this.toProvisionalDap() });
      }
    }, undefined, this._disposables);

    const promises: Promise<void>[] = [];
    {
      // For breakpoints set before launch, we don't know whether they are in a compiled or
      // a source map source. To make them work, we always set by url to not miss compiled.
      //
      // Additionally, if we have two sources with the same url, but different path (or no path),
      // this will make breakpoint work in all of them.
      const lineNumber = this._lineNumber - 1;
      const columnNumber = this._columnNumber - 1;
      promises.push(...threadManager.threads().map(thread => {
        return this._setByPath(thread, lineNumber, columnNumber);
      }));
      threadManager.onThreadAdded(thread => {
        this._setByPath(thread, lineNumber, columnNumber);
      }, undefined, this._disposables);
    }

    const source = this._manager._sourceContainer.source(this._source);
    const url = source ? source.url() : '';
    const locations = this._manager._sourceContainer.currentSiblingLocations({
      url,
      lineNumber: this._lineNumber,
      columnNumber: this._columnNumber,
      source
    });
    promises.push(...locations.map(location => this._setByLocation(location, source)));

    await Promise.all(promises);
    await this._notifyResolved();
  }

  async breakpointResolved(thread: Thread, cdpId: string, resolvedLocations: Cdp.Debugger.Location[]) {
    if (this._manager._threadManager.thread(thread.threadId()) !== thread)
      return;

    // Register cdpId so we can later remove it.
    let ids = this._perThread.get(thread.threadId());
    if (!ids) {
      ids = new Set<string>();
      this._perThread.set(thread.threadId(), ids);
    }
    ids.add(cdpId);
    this._manager._perThread.get(thread.threadId())!.set(cdpId, this);

    // If this is a first resolved location, we should update the breakpoint as "verified".
    if (this._resolvedLocation || !resolvedLocations.length)
      return;
    const location = await thread.rawLocationToUiLocation(resolvedLocations[0]);
    if (this._resolvedLocation)
      return;
    const source = this._manager._sourceContainer.source(this._source);
    if (source)
      this._resolvedLocation = this._manager._sourceContainer.currentSiblingLocations(location, source)[0];
    this._notifyResolved();
  }

  async updateForSourceMap(script: Script) {
    const source = this._manager._sourceContainer.source(this._source);
    if (!source)
      return;
    // Find all locations for this breakpoint in the new script.
    const locations = this._manager._sourceContainer.currentSiblingLocations({
      url: source.url(),
      lineNumber: this._lineNumber,
      columnNumber: this._columnNumber,
      source
    }, script.source);
    const resolvedLocation = this._resolvedLocation;
    const promises: Promise<void>[] = [];
    for (const location of locations)
      promises.push(this._setByScriptId(script.thread, script.scriptId, location.lineNumber - 1, location.columnNumber - 1));
    await Promise.all(promises);
    if (resolvedLocation !== this._resolvedLocation)
      await this._notifyResolved();
  }

  async _setByLocation(location: Location, originalSource?: Source): Promise<void> {
    const promises: Promise<void>[] = [];
    if (location.source) {
      const scripts = this._manager._threadManager.scriptsFromSource(location.source);
      for (const script of scripts)
        promises.push(this._setByScriptId(script.thread, script.scriptId, location.lineNumber - 1, location.columnNumber - 1));
    }
    if (location.url && (!originalSource || location.source !== originalSource)) {
      for (const thread of this._manager._threadManager.threads()) {
        // Threads which support "pause before script with source map" will always have
        // breakpoints resolved to specific scripts before the script is run, therefore we
        // can just set by script id above.
        //
        // For older versions of threads without this capability, we try a best-effort
        // set by url method, hoping that all scripts referring to the same source map
        // will have the same url.
        if (!thread.supportsSourceMapPause())
          promises.push(this._setByUrl(thread, location.url, location.lineNumber - 1, location.columnNumber - 1));
      }
    }
    await Promise.all(promises);
  }

  async _setByPath(thread: Thread, lineNumber: number, columnNumber: number): Promise<void> {
    const source = this._manager._sourceContainer.source(this._source);
    const url = source ? source.url() :
      (this._source.path ? thread.sourcePathResolver.absolutePathToUrl(this._source.path) : undefined);
    if (!url)
      return
    await this._setByUrl(thread, url, lineNumber, columnNumber);
  }

  async _setByUrl(thread: Thread, url: string, lineNumber: number, columnNumber: number): Promise<void> {
    const activeSetter = (async () => {
      const result = await thread.cdp().Debugger.setBreakpointByUrl({
        url,
        lineNumber,
        columnNumber,
        condition: this._condition,
      });
      if (result)
        this.breakpointResolved(thread, result.breakpointId, result.locations);
    })();
    this._activeSetters.add(activeSetter);
    await activeSetter;
  }

  async _setByScriptId(thread: Thread, scriptId: string, lineNumber: number, columnNumber: number): Promise<void> {
    const activeSetter = (async () => {
      const result = await thread.cdp().Debugger.setBreakpoint({
        location: { scriptId, lineNumber, columnNumber },
        condition: this._condition,
      });
      if (result)
        this.breakpointResolved(thread, result.breakpointId, [result.actualLocation]);
    })();
    this._activeSetters.add(activeSetter);
    await activeSetter;
  }

  async remove(): Promise<void> {
    // This prevent any new setters from running.
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables = [];
    this._resolvedLocation = undefined;

    // Let all setters finish, so that we can remove all breakpoints including
    // ones being set right now.
    await Promise.all(Array.from(this._activeSetters));

    const promises: Promise<any>[] = [];
    for (const [threadId, ids] of this._perThread) {
      const thread = this._manager._threadManager.thread(threadId)!;
      for (const id of ids) {
        this._manager._perThread.get(threadId)!.delete(id);
        promises.push(thread.cdp().Debugger.removeBreakpoint({ breakpointId: id }));
      }
    }
    this._perThread.clear();
    await promises;
  }
};

export class BreakpointManager {
  private _byPath: Map<string, Breakpoint[]> = new Map();
  private _byRef: Map<number, Breakpoint[]> = new Map();

  _dap: Dap.Api;
  _sourceContainer: SourceContainer;
  _threadManager: ThreadManager;
  _disposables: Disposable[] = [];
  _perThread = new Map<string, Map<Cdp.Debugger.BreakpointId, Breakpoint>>();

  constructor(dap: Dap.Api, sourceContainer: SourceContainer, threadManager: ThreadManager) {
    this._dap = dap;
    this._sourceContainer = sourceContainer;
    this._threadManager = threadManager;

    const onThread = (thread: Thread) => {
      this._perThread.set(thread.threadId(), new Map());
      thread.cdp().Debugger.on('breakpointResolved', event => {
        const map = this._perThread.get(thread.threadId());
        const breakpoint = map ? map.get(event.breakpointId) : undefined;
        if (breakpoint)
          breakpoint.breakpointResolved(thread, event.breakpointId, [event.location]);
      });
    };
    this._threadManager.threads().forEach(onThread);
    this._threadManager.onThreadAdded(onThread, undefined, this._disposables);
    this._threadManager.onThreadRemoved(thread => {
      this._perThread.delete(thread.threadId());
    }, undefined, this._disposables);

    this._threadManager.setScriptSourceMapHandler(async (script, sources) => {
      // New script arrived, pointing to |sources| through a source map.
      // We search for all breakpoints in |sources| and set them to this
      // particular script.
      for (const source of sources) {
        const path = source.absolutePath();
        const byPath = path ? this._byPath.get(path) : undefined;
        for (const breakpoint of byPath || [])
          breakpoint.updateForSourceMap(script);
        const byRef = this._byRef.get(source.sourceReference());
        for (const breakpoint of byRef || [])
          breakpoint.updateForSourceMap(script);
      }
    });
  }

  async setBreakpoints(params: Dap.SetBreakpointsParams, ids?: number[]): Promise<Dap.SetBreakpointsResult | Dap.Error> {
    const breakpoints: Breakpoint[] = [];
    const inBreakpoints = params.breakpoints || [];
    for (let index = 0; index < inBreakpoints.length; index++) {
      const id = ids ? ids[index] : generateBreakpointId();
      breakpoints.push(new Breakpoint(this, id, params.source, inBreakpoints[index]));
    }
    let previous: Breakpoint[] | undefined;
    if (params.source.path) {
      previous = this._byPath.get(params.source.path);
      this._byPath.set(params.source.path, breakpoints);
    } else {
      previous = this._byRef.get(params.source.sourceReference!);
      this._byRef.set(params.source.sourceReference!, breakpoints);
    }
    // Cleanup existing breakpoints before setting new ones.
    if (previous)
      await Promise.all(previous.map(b => b.remove()));
    breakpoints.forEach(b => b.set());
    return { breakpoints: breakpoints.map(b => b.toProvisionalDap()) };
  }
}

export const kLogPointUrl = 'logpoint.cdp';

function logMessageToExpression(msg: string): string {
  msg = msg.replace('%', '%%');
  const args: string[] = [];
  let format = msg.replace(/{(.*?)}/g, (match, group) => {
    const a = group.trim();
    if (a) {
      args.push(`(${a})`);
      return '%O';
    } else {
      return '';
    }
  });
  format = format.replace('\'', '\\\'');
  const argStr = args.length ? `, ${args.join(', ')}` : '';
  return `console.log('${format}'${argStr});\n//# sourceURL=${kLogPointUrl}`;
}

let lastBreakpointId = 0;

export function generateBreakpointId(): number {
  return ++lastBreakpointId;
}
