// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { UiLocation, SourceContainer, Source, uiToRawOffset } from './sources';
import Dap from '../dap/api';
import Cdp from '../cdp/api';
import { Thread, Script, ScriptWithSourceMapHandler } from './threads';
import { Disposable } from 'vscode';
import { BreakpointsPredictor } from './breakpointPredictor';
import * as urlUtils from '../utils/urlUtils';

let lastBreakpointId = 0;

type LineColumn = { lineNumber: number, columnNumber: number }; // 1-based

export class Breakpoint {
  private _manager: BreakpointManager;
  private _dapId: number;
  _source: Dap.Source;
  private _condition?: string;
  private _lineColumn: LineColumn;
  private _disposables: Disposable[] = [];
  private _activeSetters = new Set<Promise<void>>();

  private _resolvedBreakpoints = new Set<Cdp.Debugger.BreakpointId>();
  private _resolvedUiLocation?: UiLocation;

  constructor(manager: BreakpointManager, dapId: number, source: Dap.Source, params: Dap.SourceBreakpoint) {
    this._manager = manager;
    this._dapId = dapId;
    this._source = source;
    this._lineColumn = {lineNumber: params.line, columnNumber: params.column || 1};
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
    if (!this._resolvedUiLocation)
      return;
    this._manager._dap.breakpoint({
      reason: 'changed',
      breakpoint: {
        id: this._dapId,
        verified: true,
        source: await this._resolvedUiLocation.source.toDap(),
        line: this._resolvedUiLocation.lineNumber,
        column: this._resolvedUiLocation.columnNumber
      }
    });
  }

  async set(thread: Thread): Promise<void> {
    const promises: Promise<void>[] = [
      // For breakpoints set before launch, we don't know whether they are in a compiled or
      // a source map source. To make them work, we always set by url to not miss compiled.
      // Additionally, if we have two sources with the same url, but different path (or no path),
      // this will make breakpoint work in all of them.
      this._setByPath(thread, this._lineColumn),

      // Also use predicted locations if available.
      this._setPredicted(thread)
    ];

    const source = this._manager._sourceContainer.source(this._source);
    if (source) {
      const uiLocations = this._manager._sourceContainer.currentSiblingUiLocations({
        lineNumber: this._lineColumn.lineNumber,
        columnNumber: this._lineColumn.columnNumber,
        source
      });
      promises.push(...uiLocations.map(uiLocation => this._setByUiLocation(thread, uiLocation)));
    }

    await Promise.all(promises);
    await this._notifyResolved();
  }

  async breakpointResolved(thread: Thread, cdpId: string, resolvedLocations: Cdp.Debugger.Location[]) {
    // Register cdpId so we can later remove it.
    this._resolvedBreakpoints.add(cdpId);
    this._manager._resolvedBreakpoints.set(cdpId, this);

    // If this is a first resolved location, we should update the breakpoint as "verified".
    if (this._resolvedUiLocation || !resolvedLocations.length)
      return;
    const uiLocation = await thread.rawLocationToUiLocation(thread.rawLocation(resolvedLocations[0]));
    if (this._resolvedUiLocation || !uiLocation)
      return;
    const source = this._manager._sourceContainer.source(this._source);
    if (source)
      this._resolvedUiLocation = this._manager._sourceContainer.currentSiblingUiLocations(uiLocation, source)[0];
    this._notifyResolved();
  }

  async updateForSourceMap(thread: Thread, script: Script) {
    const source = this._manager._sourceContainer.source(this._source);
    if (!source)
      return;
    // Find all locations for this breakpoint in the new script.
    const uiLocations = this._manager._sourceContainer.currentSiblingUiLocations({
      lineNumber: this._lineColumn.lineNumber,
      columnNumber: this._lineColumn.columnNumber,
      source
    }, script.source);
    const promises: Promise<void>[] = [];
    for (const uiLocation of uiLocations)
      promises.push(this._setByScriptId(thread, script.scriptId, uiLocation));
    await Promise.all(promises);
  }

  async _setPredicted(thread: Thread): Promise<void> {
    if (!this._source.path || !this._manager._breakpointsPredictor)
      return;
    const workspaceLocations = this._manager._breakpointsPredictor.predictedResolvedLocations({
      absolutePath: this._source.path,
      lineNumber: this._lineColumn.lineNumber,
      columnNumber: this._lineColumn.columnNumber
    });
    const promises: Promise<void>[] = [];
    for (const workspaceLocation of workspaceLocations) {
      const url = thread.sourcePathResolver.absolutePathToUrl(workspaceLocation.absolutePath);
      if (url)
        promises.push(this._setByUrl(thread, url, workspaceLocation));
    }
    await Promise.all(promises);
  }

  async _setByUiLocation(thread: Thread, uiLocation: UiLocation): Promise<void> {
    const promises: Promise<void>[] = [];
    const scripts = thread.scriptsFromSource(uiLocation.source);
    for (const script of scripts)
      promises.push(this._setByScriptId(thread, script.scriptId, uiLocation));
    await Promise.all(promises);
  }

  async _setByPath(thread: Thread, lineColumn: LineColumn): Promise<void> {
    const source = this._manager._sourceContainer.source(this._source);
    const url = source ? source.url() :
      (this._source.path ? thread.sourcePathResolver.absolutePathToUrl(this._source.path) : undefined);
    if (!url)
      return;
    await this._setByUrl(thread, url, lineColumn);
  }

  async _setByUrl(thread: Thread, url: string, lineColumn: LineColumn): Promise<void> {
    const activeSetter = (async () => {
      // TODO: add a test for this - breakpoint in node on the first line.
      lineColumn = uiToRawOffset(lineColumn, thread.defaultScriptOffset());
      const result = await thread.cdp().Debugger.setBreakpointByUrl({
        url,
        lineNumber: lineColumn.lineNumber - 1,
        columnNumber: lineColumn.columnNumber - 1,
        condition: this._condition,
      });
      if (result)
        this.breakpointResolved(thread, result.breakpointId, result.locations);
    })();
    this._activeSetters.add(activeSetter);
    await activeSetter;
  }

  async _setByScriptId(thread: Thread, scriptId: string, lineColumn: LineColumn): Promise<void> {
    const activeSetter = (async () => {
      lineColumn = uiToRawOffset(lineColumn, thread.defaultScriptOffset());
      const result = await thread.cdp().Debugger.setBreakpoint({
        location: { scriptId, lineNumber: lineColumn.lineNumber - 1, columnNumber: lineColumn.columnNumber - 1 },
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
    this._resolvedUiLocation = undefined;

    // Let all setters finish, so that we can remove all breakpoints including
    // ones being set right now.
    await Promise.all(Array.from(this._activeSetters));

    const promises: Promise<any>[] = [];
    for (const id of this._resolvedBreakpoints) {
      this._manager._resolvedBreakpoints.delete(id);
      promises.push(this._manager._thread!.cdp().Debugger.removeBreakpoint({ breakpointId: id }));
    }
    this._resolvedBreakpoints.clear();
    await Promise.all(promises);
  }
};

export class BreakpointManager {
  private _byPath: Map<string, Breakpoint[]> = new Map();
  private _byRef: Map<number, Breakpoint[]> = new Map();

  _dap: Dap.Api;
  _sourceContainer: SourceContainer;
  _thread: Thread | undefined;
  _disposables: Disposable[] = [];
  _resolvedBreakpoints = new Map<Cdp.Debugger.BreakpointId, Breakpoint>();
  _totalBreakpointsCount = 0;
  _scriptSourceMapHandler: ScriptWithSourceMapHandler;
  _breakpointsPredictor?: BreakpointsPredictor;
  private _launchBlocker: Promise<any> = Promise.resolve();
  private _sourceMapPauseDisabledForTest = false;
  private _predictorDisabledForTest = false;

  constructor(dap: Dap.Api, sourceContainer: SourceContainer) {
    this._dap = dap;
    this._sourceContainer = sourceContainer;

    this._scriptSourceMapHandler = async (script, sources) => {
      // New script arrived, pointing to |sources| through a source map.
      // We search for all breakpoints in |sources| and set them to this
      // particular script.
      for (const source of sources) {
        const path = source.absolutePath();
        const byPath = path ? this._byPath.get(path) : undefined;
        for (const breakpoint of byPath || [])
          breakpoint.updateForSourceMap(this._thread!, script);
        const byRef = this._byRef.get(source.sourceReference());
        for (const breakpoint of byRef || [])
          breakpoint.updateForSourceMap(this._thread!, script);
      }
    };
    if (sourceContainer.rootPath)
      this._breakpointsPredictor = new BreakpointsPredictor(sourceContainer.rootPath);
  }

  setThread(thread: Thread) {
    this._thread = thread;
    this._thread.cdp().Debugger.on('breakpointResolved', event => {
      const breakpoint = this._resolvedBreakpoints.get(event.breakpointId);
      if (breakpoint)
        breakpoint.breakpointResolved(thread, event.breakpointId, [event.location]);
    });
    this._thread.setSourceMapDisabler(breakpointIds => {
      const sources: Source[] = [];
      for (const id of breakpointIds) {
        const breakpoint = this._resolvedBreakpoints.get(id);
        if (breakpoint) {
          const source = this._sourceContainer.source(breakpoint._source);
          if (source)
            sources.push(source);
        }
      }
      return sources;
    });
    for (const breakpoints of this._byPath.values())
      breakpoints.forEach(b => b.set(thread));
    for (const breakpoints of this._byRef.values())
      breakpoints.forEach(b => b.set(thread));
    this._updateSourceMapHandler();
  }

  async launchBlocker(): Promise<void> {
    return this._predictorDisabledForTest ? Promise.resolve() : this._launchBlocker;
  }

  setSourceMapPauseDisabledForTest(disabled: boolean) {
    this._sourceMapPauseDisabledForTest = disabled;
  }

  setPredictorDisabledForTest(disabled: boolean) {
    this._predictorDisabledForTest = disabled;
  }

  async _updateSourceMapHandler() {
    if (!this._thread)
      return;
    const enableSourceMapHandler = this._totalBreakpointsCount && !this._sourceMapPauseDisabledForTest;
    await this._thread.setScriptSourceMapHandler(enableSourceMapHandler ? this._scriptSourceMapHandler : undefined);
  }

  async setBreakpoints(params: Dap.SetBreakpointsParams): Promise<Dap.SetBreakpointsResult | Dap.Error> {
    params.source.path = urlUtils.platformPathToPreferredCase(params.source.path);
    if (!this._predictorDisabledForTest && this._breakpointsPredictor) {
      const promise = this._breakpointsPredictor!.predictBreakpoints(params);
      this._launchBlocker = Promise.all([this._launchBlocker, promise]);
      await promise;
    }
    const breakpoints: Breakpoint[] = [];
    const inBreakpoints = params.breakpoints || [];
    for (let index = 0; index < inBreakpoints.length; index++) {
      const id = ++lastBreakpointId;
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
    if (previous) {
      this._totalBreakpointsCount -= previous.length;
      await Promise.all(previous.map(b => b.remove()));
    }
    this._totalBreakpointsCount += breakpoints.length;
    if (this._thread)
      breakpoints.forEach(b => b.set(this._thread!));
    this._updateSourceMapHandler();
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
