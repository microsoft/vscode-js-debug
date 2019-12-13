/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IUiLocation, SourceContainer, Source, uiToRawOffset, base1To0 } from './sources';
import * as nls from 'vscode-nls';
import Dap from '../dap/api';
import Cdp from '../cdp/api';
import { Thread, Script, ScriptWithSourceMapHandler } from './threads';
import { IDisposable } from '../common/events';
import { BreakpointsPredictor } from './breakpointPredictor';
import * as urlUtils from '../common/urlUtils';
import { rewriteLogPoint } from '../common/sourceUtils';
import { BreakpointsStatisticsCalculator } from '../statistics/breakpointsStatistics';
import { TelemetryEntityProperties } from '../telemetry/telemetryReporter';
import { logger, assert } from '../common/logging/logger';
import { LogTag } from '../common/logging';
import { getDeferred, delay } from '../common/promiseUtil';

const localize = nls.loadMessageBundle();

type LineColumn = { lineNumber: number; columnNumber: number }; // 1-based

/**
 * Differential result used internally in setBreakpoints.
 */
interface ISetBreakpointResult {
  /**
   * Breakpoints that previous existed which can be destroyed.
   */
  unbound: Breakpoint[];
  /**
   * Newly created breakpoints;
   */
  new: Breakpoint[];
  /**
   * All old and new breakpoints.
   */
  list: Breakpoint[];
}

/**
 * State of the IBreakpointCdpReference.
 */
const enum CdpReferenceState {
  // We're still working on the initial 'set breakpoint' request for this.
  Applying,
  // CDP has resolved this breakpoint to a source location locations.
  Resolved,
}

type AnyCdpBreakpointArgs =
  | Cdp.Debugger.SetBreakpointByUrlParams
  | Cdp.Debugger.SetBreakpointParams;

const isSetByUrl = (
  params: AnyCdpBreakpointArgs,
): params is Cdp.Debugger.SetBreakpointByUrlParams => !('location' in params);
const isSetByLocation = (
  params: AnyCdpBreakpointArgs,
): params is Cdp.Debugger.SetBreakpointParams => 'location' in params;

const breakpointIsForUrl = (params: Cdp.Debugger.SetBreakpointByUrlParams, url: string) =>
  (params.url && url === params.url) || params.urlRegex === urlUtils.urlToRegex(url);

/**
 * We're currently working on sending the breakpoint to CDP.
 */
interface IBreakpointCdpReferencePending {
  state: CdpReferenceState.Applying;
  // If deadletter is true, it indicates we want to invalidate this breakpoint;
  // this will cause it to be unset as soon as it is applied.
  deadletter: boolean;
  // Promise that resolves to the 'applied' state once applied, or void if an
  // error or deadletter occurred.
  done: Promise<IBreakpointCdpReferenceApplied | void>;
  // Arguments used to set the breakpoint.
  args: AnyCdpBreakpointArgs;
}

/**
 * The breakpoint has been acknowledged by CDP and mapped to one or more locations.
 */
interface IBreakpointCdpReferenceApplied {
  state: CdpReferenceState.Resolved;
  // ID of the breakpoint on CDP.
  cdpId: Cdp.Debugger.BreakpointId;
  // Locations where CDP told us the breakpoint has bound.
  locations: ReadonlyArray<Cdp.Debugger.Location>;
  // Arguments used to set the breakpoint.
  args: AnyCdpBreakpointArgs;
  // A list of UI locations whether this breakpoint was resolved.
  uiLocations: IUiLocation[];
}

/**
 * An entry in the Breakpoint class that references a breakpoint in CDP/the
 * debug target. A single "Breakpoint" class might resolve to
 * multiple source locations, so there is a list of these.
 */
type BreakpointCdpReference = IBreakpointCdpReferencePending | IBreakpointCdpReferenceApplied;

export class Breakpoint {
  private _manager: BreakpointManager;
  _source: Dap.Source;
  private _condition?: string;
  private _lineColumn: LineColumn;

  /**
   * A list of the CDP breakpoints that have been set from this one.
   */
  private _cdpBreakpoints: BreakpointCdpReference[] = [];

  /**
   * A deferred that resolves once the breakpoint 'set' response has been
   * returned to the UI. We should wait for this to finish before sending any
   * notifications about breakpoint changes.
   */
  private _completedSet = getDeferred<void>();

  constructor(
    manager: BreakpointManager,
    public readonly dapId: number,
    source: Dap.Source,
    params: Dap.SourceBreakpoint,
  ) {
    this._manager = manager;
    this.dapId = dapId;
    this._source = source;
    this._lineColumn = { lineNumber: params.line, columnNumber: params.column || 1 };
    if (params.logMessage)
      this._condition = rewriteLogPoint(params.logMessage) + `\n//# sourceURL=${kLogPointUrl}`;
    if (params.condition)
      this._condition = this._condition
        ? `(${params.condition}) && ${this._condition}`
        : params.condition;
  }

  /**
   * Returns a promise that resolves once the breakpoint 'set' response
   */
  public untilSetCompleted() {
    return this._completedSet.promise;
  }

  /**
   * Marks the breakpoint 'set' as having finished.
   */
  public markSetCompleted() {
    this._completedSet.resolve();
  }

  /**
   * Returns a DAP representation of the breakpoint. If the breakpoint is
   * resolved, this will be fulfilled with the complete source location.
   */
  public async toDap(): Promise<Dap.Breakpoint> {
    const location = this.getResolvedUiLocation();
    if (location) {
      return {
        id: this.dapId,
        verified: true,
        source: await location.source.toDap(),
        line: location.lineNumber,
        column: location.columnNumber,
      };
    }

    return {
      id: this.dapId,
      verified: false,
      message: localize('breakpoint.provisionalBreakpoint', `Unbound breakpoint`), // TODO: Put a useful message here
    };
  }

  /**
   * Gets the location whether this breakpoint is resolved, if any.
   */
  private getResolvedUiLocation() {
    for (const bp of this._cdpBreakpoints) {
      if (bp.state === CdpReferenceState.Resolved && bp.uiLocations.length) {
        return bp.uiLocations[0];
      }
    }

    return undefined;
  }

  /**
   * Called the breakpoint manager to notify that the breakpoint is resolved,
   * used for statistics and notifying the UI.
   */
  private async notifyResolved(): Promise<void> {
    const location = this.getResolvedUiLocation();
    if (location) {
      await this._manager.notifyBreakpointResolved(
        this.dapId,
        location,
        this._completedSet.hasSettled(),
      );
    }
  }

  async set(thread: Thread): Promise<void> {
    const promises: Promise<void>[] = [
      // For breakpoints set before launch, we don't know whether they are in a compiled or
      // a source map source. To make them work, we always set by url to not miss compiled.
      // Additionally, if we have two sources with the same url, but different path (or no path),
      // this will make breakpoint work in all of them.
      this._setByPath(thread, this._lineColumn),

      // Also use predicted locations if available.
      this._setPredicted(thread),
    ];

    const source = this._manager._sourceContainer.source(this._source);
    if (source) {
      const uiLocations = this._manager._sourceContainer.currentSiblingUiLocations({
        lineNumber: this._lineColumn.lineNumber,
        columnNumber: this._lineColumn.columnNumber,
        source,
      });
      promises.push(...uiLocations.map(uiLocation => this._setByUiLocation(thread, uiLocation)));
    }

    await Promise.all(promises);
    await this.notifyResolved();
  }

  /**
   * Updates the breakpoint's locations in the UI. Should be called whenever
   * a breakpoint set completes or a breakpointResolved event is received.
   */
  public async updateUiLocations(
    thread: Thread,
    cdpId: Cdp.Debugger.BreakpointId,
    resolvedLocations: Cdp.Debugger.Location[],
  ) {
    const uiLocation = (
      await Promise.all(
        resolvedLocations.map(l => thread.rawLocationToUiLocation(thread.rawLocation(l))),
      )
    ).find(l => !!l);

    if (!uiLocation) {
      return;
    }

    const source = this._manager._sourceContainer.source(this._source);
    if (!source) {
      return;
    }

    const hadPreviousLocation = !!this.getResolvedUiLocation();
    for (const bp of this._cdpBreakpoints) {
      if (bp.state === CdpReferenceState.Resolved && bp.cdpId === cdpId) {
        bp.uiLocations = bp.uiLocations.concat(
          this._manager._sourceContainer.currentSiblingUiLocations(uiLocation, source),
        );
      }
    }

    if (!hadPreviousLocation) {
      this.notifyResolved();
    }
  }

  public async updateForSourceMap(thread: Thread, script: Script) {
    const source = this._manager._sourceContainer.source(this._source);
    if (!source) {
      return [];
    }

    // Find all locations for this breakpoint in the new script.
    const uiLocations = this._manager._sourceContainer.currentSiblingUiLocations(
      {
        lineNumber: this._lineColumn.lineNumber,
        columnNumber: this._lineColumn.columnNumber,
        source,
      },
      script.source,
    );

    if (!uiLocations.length) {
      return [];
    }

    const promises: Promise<void>[] = [];
    for (const uiLocation of uiLocations) {
      promises.push(this._setByScriptId(thread, script, uiLocation));
    }

    // If we get a source map that references this script exact URL, then
    // remove any URL-set breakpoints because they are probably not correct.
    // This oft happens with Node.js loaders which rewrite sources on the fly.
    for (const bp of this._cdpBreakpoints) {
      if (isSetByUrl(bp.args) && breakpointIsForUrl(bp.args, source.url())) {
        logger.verbose(LogTag.RuntimeSourceMap, 'Adjusted breakpoint due to overlaid sourcemap', {
          url: source.url(),
        });
        promises.push(this.removeCdpBreakpoint(bp));
      }
    }

    await Promise.all(promises);

    return uiLocations;
  }

  async _setPredicted(thread: Thread): Promise<void> {
    if (!this._source.path || !this._manager._breakpointsPredictor) return;
    const workspaceLocations = this._manager._breakpointsPredictor.predictedResolvedLocations({
      absolutePath: this._source.path,
      lineNumber: this._lineColumn.lineNumber,
      columnNumber: this._lineColumn.columnNumber,
    });
    const promises: Promise<void>[] = [];
    for (const workspaceLocation of workspaceLocations) {
      const url = this._manager._sourceContainer.sourcePathResolver.absolutePathToUrl(
        workspaceLocation.absolutePath,
      );
      if (url) promises.push(this._setByUrl(thread, url, workspaceLocation));
    }
    await Promise.all(promises);
  }

  async _setByUiLocation(thread: Thread, uiLocation: IUiLocation): Promise<void> {
    const promises: Promise<void>[] = [];
    const scripts = thread.scriptsFromSource(uiLocation.source);
    for (const script of scripts) promises.push(this._setByScriptId(thread, script, uiLocation));
    await Promise.all(promises);
  }

  async _setByPath(thread: Thread, lineColumn: LineColumn): Promise<void> {
    const source = this._manager._sourceContainer.source(this._source);
    const url = source
      ? source.url()
      : this._source.path
      ? this._manager._sourceContainer.sourcePathResolver.absolutePathToUrl(this._source.path)
      : undefined;
    if (!url) return;
    await this._setByUrl(thread, url, lineColumn);
  }

  /**
   * Returns whether a breakpoint has been set on the given line and column
   * at the provided URL already. This is used to deduplicate breakpoint
   * requests--as URLs do not refer explicitly to a single script, there's
   * not an intrinsic deduplication that happens before this point.
   */
  private hasSetOnLocation(urlRegex: string, lineColumn: LineColumn): boolean {
    return this._cdpBreakpoints.some(
      bp =>
        isSetByUrl(bp.args) &&
        bp.args.urlRegex === urlRegex &&
        bp.args.lineNumber === lineColumn.lineNumber &&
        bp.args.columnNumber === lineColumn.columnNumber,
    );
  }

  private async _setByUrl(thread: Thread, url: string, lineColumn: LineColumn): Promise<void> {
    const urlRegex = urlUtils.urlToRegex(url);
    lineColumn = base1To0(uiToRawOffset(lineColumn, thread.defaultScriptOffset()));
    if (this.hasSetOnLocation(urlRegex, lineColumn)) {
      return;
    }

    return this._setAny(thread, {
      urlRegex,
      condition: this._condition,
      ...lineColumn,
    });
  }

  private async _setByScriptId(
    thread: Thread,
    script: Script,
    lineColumn: LineColumn,
  ): Promise<void> {
    lineColumn = base1To0(uiToRawOffset(lineColumn, thread.defaultScriptOffset()));
    if (script.url && this.hasSetOnLocation(urlUtils.urlToRegex(script.url), lineColumn)) {
      return;
    }

    return this._setAny(thread, { location: { scriptId: script.scriptId, ...lineColumn } });
  }

  /**
   * Sets a breakpoint on the thread using the given set of arguments
   * to Debugger.setBreakpoint or Debugger.setBreakpointByUrl.
   */
  private async _setAny(thread: Thread, args: AnyCdpBreakpointArgs) {
    const state: Partial<IBreakpointCdpReferencePending> = {
      state: CdpReferenceState.Applying,
      args,
      deadletter: false,
    };

    state.done = (async () => {
      const result = isSetByLocation(args)
        ? await thread.cdp().Debugger.setBreakpoint(args)
        : await thread.cdp().Debugger.setBreakpointByUrl(args);
      if (!result) {
        return;
      }

      if (state.deadletter) {
        await thread.cdp().Debugger.removeBreakpoint({ breakpointId: result.breakpointId });
        return;
      }

      const locations = 'actualLocation' in result ? [result.actualLocation] : result.locations;
      this._manager._resolvedBreakpoints.set(result.breakpointId, this);

      // Note that we add the record after calling breakpointResolved()
      // to avoid duplicating locations.
      const next: IBreakpointCdpReferenceApplied = {
        state: CdpReferenceState.Resolved,
        cdpId: result.breakpointId,
        args,
        locations,
        uiLocations: [],
      };
      this._cdpBreakpoints = this._cdpBreakpoints.map(r => (r === state ? next : r));

      this.updateUiLocations(thread, result.breakpointId, locations);
      return next;
    })();

    this._cdpBreakpoints.push(state as IBreakpointCdpReferencePending);
    await state.done;
  }

  async remove(): Promise<void> {
    const promises: Promise<unknown>[] = this._cdpBreakpoints.map(bp =>
      this.removeCdpBreakpoint(bp, false),
    );
    this._cdpBreakpoints = [];
    await Promise.all(promises);
  }

  /**
   * Removes a CDP breakpoint attached to this one. Deadletters it if it
   * hasn't been applied yet, deletes it immediately otherwise.
   */
  private async removeCdpBreakpoint(breakpoint: BreakpointCdpReference, notify = true) {
    const previousLocation = this.getResolvedUiLocation();
    this._cdpBreakpoints = this._cdpBreakpoints.filter(bp => bp !== breakpoint);
    if (breakpoint.state === CdpReferenceState.Applying) {
      breakpoint.deadletter = true;
      await breakpoint.done;
    } else {
      this._manager._resolvedBreakpoints.delete(breakpoint.cdpId);
      await this._manager._thread
        ?.cdp()
        .Debugger.removeBreakpoint({ breakpointId: breakpoint.cdpId });
    }

    if (notify && previousLocation !== this.getResolvedUiLocation()) {
      this.notifyResolved();
    }
  }

  /**
   * Compares this breakpoint with the other. String comparison-style return:
   *  - a negative number if this breakpoint is before the other one
   *  - zero if they're the same location
   *  - a positive number if this breakpoint is after the other one
   */
  public compare(other: Breakpoint) {
    const lca = this._lineColumn;
    const lcb = other._lineColumn;
    return lca.lineNumber !== lcb.lineNumber
      ? lca.lineNumber - lcb.lineNumber
      : lca.columnNumber - lcb.columnNumber;
  }
}

export class BreakpointManager {
  private _byPath: Map<string, Breakpoint[]> = new Map();
  private _byRef: Map<number, Breakpoint[]> = new Map();

  _dap: Dap.Api;
  _sourceContainer: SourceContainer;
  _thread: Thread | undefined;
  _disposables: IDisposable[] = [];
  _resolvedBreakpoints = new Map<Cdp.Debugger.BreakpointId, Breakpoint>();
  _totalBreakpointsCount = 0;
  _scriptSourceMapHandler: ScriptWithSourceMapHandler;
  private _launchBlocker: Promise<unknown> = Promise.resolve();
  private _predictorDisabledForTest = false;
  private _breakpointsStatisticsCalculator = new BreakpointsStatisticsCalculator();

  constructor(
    dap: Dap.Api,
    sourceContainer: SourceContainer,
    private readonly pauseForSourceMaps: boolean,
    public readonly _breakpointsPredictor?: BreakpointsPredictor,
  ) {
    this._dap = dap;
    this._sourceContainer = sourceContainer;

    this._scriptSourceMapHandler = async (script, sources) => {
      const todo: Promise<IUiLocation[]>[] = [];

      if (
        !assert(this._thread, 'Expected thread to be set for the breakpoint source map handler')
      ) {
        return { remainPaused: false };
      }

      // New script arrived, pointing to |sources| through a source map.
      // We search for all breakpoints in |sources| and set them to this
      // particular script.
      for (const source of sources) {
        const path = source.absolutePath();
        const byPath = path ? this._byPath.get(path) : undefined;
        for (const breakpoint of byPath || [])
          todo.push(breakpoint.updateForSourceMap(this._thread, script));
        const byRef = this._byRef.get(source.sourceReference());
        for (const breakpoint of byRef || [])
          todo.push(breakpoint.updateForSourceMap(this._thread, script));
      }

      const result = await Promise.all(todo);

      return {
        remainPaused: result.some(r => r.some(l => l.columnNumber <= 1 && l.lineNumber <= 1)),
      };
    };
  }

  /**
   * Returns possible breakpoint locations for the given range.
   */
  public async getBreakpointLocations(
    thread: Thread,
    request: Dap.BreakpointLocationsParams,
  ): Promise<Dap.BreakpointLocation[]> {
    // Find the source we're querying in, then resolve all possibly sourcemapped
    // locations for that script.
    const source = this._sourceContainer.source(request.source);
    if (!source) {
      return [];
    }

    const startLocations = this._sourceContainer.currentSiblingUiLocations({
      source,
      lineNumber: request.line,
      columnNumber: request.column === undefined ? 1 : request.column,
    });

    const endLocations = this._sourceContainer.currentSiblingUiLocations({
      source,
      lineNumber: request.endLine === undefined ? request.line + 1 : request.endLine,
      columnNumber: request.endColumn === undefined ? 1 : request.endColumn,
    });

    // As far as I know the number of start and end locations should be the
    // same, log if this is not the case.
    if (startLocations.length !== endLocations.length) {
      logger.warn(LogTag.Internal, 'Expected to have the same number of start and end locations');
      return [];
    }

    // For each viable location, attempt to identify its script ID and then ask
    // Chrome for the breakpoints in the given range. For almost all scripts
    // we'll only every find one viable location with a script.
    const todo: Promise<Dap.BreakpointLocation[]>[] = [];
    for (let i = 0; i < startLocations.length; i++) {
      const start = startLocations[i];
      const end = endLocations[i];

      if (start.source !== end.source) {
        logger.warn(LogTag.Internal, 'Expected to have the same number of start and end scripts');
        continue;
      }

      // Only take the first script that matches this source. The breakpoints
      // are all coming from the same source code, so possible breakpoints
      // at one location where this source is present should match every other.
      const scripts = thread.scriptsFromSource(start.source);
      if (scripts.size === 0) {
        continue;
      }

      const { scriptId } = scripts.values().next().value as Script;
      todo.push(
        thread
          .cdp()
          .Debugger.getPossibleBreakpoints({
            restrictToFunction: false,
            start: { scriptId, ...base1To0(start) },
            end: { scriptId, ...base1To0(end) },
          })
          .then(r => {
            if (!r) {
              return [];
            }

            // Map the locations from CDP back to their original source positions.
            // Discard any that map outside of the source we're interested in,
            // which is possible (e.g. if a section of code from one source is
            // inlined amongst the range we request).
            const result: Dap.BreakpointLocation[] = [];
            for (const location of r.locations) {
              const sourceLocations = this._sourceContainer.currentSiblingUiLocations(
                {
                  source: start.source,
                  lineNumber: location.lineNumber + 1,
                  columnNumber: (location.columnNumber || 0) + 1,
                },
                source,
              );

              for (const srcLocation of sourceLocations) {
                result.push({ line: srcLocation.lineNumber, column: srcLocation.columnNumber });
              }
            }

            return result;
          }),
      );
    }

    // Gather our results and flatten the array.
    return (await Promise.all(todo)).reduce((acc, r) => [...acc, ...r], []);
  }

  /**
   * Updates the thread the breakpoint manager is attached to.
   */
  public setThread(thread: Thread) {
    this._thread = thread;
    this._thread.cdp().Debugger.on('breakpointResolved', event => {
      const breakpoint = this._resolvedBreakpoints.get(event.breakpointId);
      if (breakpoint) {
        breakpoint.updateUiLocations(thread, event.breakpointId, [event.location]);
      }
    });

    this._thread.setSourceMapDisabler(breakpointIds => {
      const sources: Source[] = [];
      for (const id of breakpointIds) {
        const breakpoint = this._resolvedBreakpoints.get(id);
        if (breakpoint) {
          const source = this._sourceContainer.source(breakpoint._source);
          if (source) sources.push(source);
        }
      }
      return sources;
    });
    for (const breakpoints of this._byPath.values())
      breakpoints.forEach(b => this._setBreakpoint(b, thread));
    for (const breakpoints of this._byRef.values())
      breakpoints.forEach(b => this._setBreakpoint(b, thread));
    this._updateSourceMapHandler(this._thread);
  }

  async launchBlocker(): Promise<void> {
    if (!this._predictorDisabledForTest) {
      await this._launchBlocker;
    }
  }

  setSourceMapPauseDisabledForTest() {
    // this._sourceMapPauseDisabledForTest = disabled;
  }

  setPredictorDisabledForTest(disabled: boolean) {
    this._predictorDisabledForTest = disabled;
  }

  async _updateSourceMapHandler(thread: Thread) {
    await thread.setScriptSourceMapHandler(this._scriptSourceMapHandler);

    if (!this._breakpointsPredictor || this.pauseForSourceMaps) {
      return;
    }

    // If we set a predictor and don't want to pause, we still wait to wait
    // for the predictor to finish running. Uninstall the sourcemap handler
    // once we see the predictor is ready to roll.
    await this._breakpointsPredictor.prepareToPredict();
    thread.setScriptSourceMapHandler(undefined);
  }

  private _setBreakpoint(b: Breakpoint, thread: Thread): void {
    this._launchBlocker = Promise.all([this._launchBlocker, b.set(thread)]);
  }

  async setBreakpoints(
    params: Dap.SetBreakpointsParams,
    ids: number[],
  ): Promise<Dap.SetBreakpointsResult> {
    params.source.path = urlUtils.platformPathToPreferredCase(params.source.path);

    // Wait until the breakpoint predictor finishes to be sure that we
    // can place correctly in breakpoint.set().
    if (!this._predictorDisabledForTest && this._breakpointsPredictor) {
      const promise = this._breakpointsPredictor.predictBreakpoints(params);
      this._launchBlocker = Promise.all([this._launchBlocker, promise]);
      await promise;
    }

    // Creates new breakpoints for the parameters, unsetting any previous
    // breakpoints that don't still exist in the params.
    const mergeInto = (previous: Breakpoint[]): ISetBreakpointResult => {
      const result: ISetBreakpointResult = { unbound: previous.slice(), new: [], list: [] };
      if (!params.breakpoints) {
        return result;
      }

      for (let index = 0; index < params.breakpoints.length; index++) {
        const created = new Breakpoint(this, ids[index], params.source, params.breakpoints[index]);
        const existingIndex = result.unbound.findIndex(p => p.compare(created) === 0);
        if (existingIndex === -1) {
          result.new.push(created);
          result.list.push(created);
          continue;
        }

        const existing = result.unbound[existingIndex];
        result.list.push(existing);
        result.unbound.splice(existingIndex, 1);
      }

      return result;
    };

    let result: ISetBreakpointResult;
    if (params.source.path) {
      result = mergeInto(this._byPath.get(params.source.path) || []);
      this._byPath.set(params.source.path, result.list);
    } else if (params.source.sourceReference) {
      result = mergeInto(this._byRef.get(params.source.sourceReference) || []);
      this._byRef.set(params.source.sourceReference, result.list);
    } else {
      return { breakpoints: [] };
    }

    // Cleanup existing breakpoints before setting new ones.
    this._totalBreakpointsCount -= result.unbound.length;
    await Promise.all(result.unbound.map(b => b.remove()));

    this._totalBreakpointsCount += result.new.length;

    const thread = this._thread;
    if (thread) {
      await (this._launchBlocker = Promise.all([
        this._launchBlocker,
        ...result.new.map(b => b.set(thread)),
      ]));
    }

    const dapBreakpoints = await Promise.all(result.list.map(b => b.toDap()));
    this._breakpointsStatisticsCalculator.registerBreakpoints(dapBreakpoints);

    // In the next task after we send the response to the adapter, mark the
    // breakpoints as having been set.
    delay(0).then(() => result.new.forEach(bp => bp.markSetCompleted()));

    return { breakpoints: dapBreakpoints };
  }

  public async notifyBreakpointResolved(
    breakpointId: number,
    location: IUiLocation,
    emitChange: boolean,
  ): Promise<void> {
    this._breakpointsStatisticsCalculator.registerResolvedBreakpoint(breakpointId);
    if (emitChange) {
      this._dap.breakpoint({
        reason: 'changed',
        breakpoint: {
          id: breakpointId,
          verified: true,
          source: await location.source.toDap(),
          line: location.lineNumber,
          column: location.columnNumber,
        },
      });
    }
  }

  public notifyBreakpointHit(hitBreakpointIds: string[]): void {
    hitBreakpointIds.forEach(breakpointId => {
      const breakpoint = this._resolvedBreakpoints.get(breakpointId);
      if (breakpoint) {
        const id = breakpoint.dapId;
        this._breakpointsStatisticsCalculator.registerBreakpointHit(id);
      }
    });
  }

  public statisticsForTelemetry(): TelemetryEntityProperties {
    return this._breakpointsStatisticsCalculator.statistics();
  }
}

export const kLogPointUrl = 'logpoint.cdp';

let lastBreakpointId = 0;
export function generateBreakpointIds(params: Dap.SetBreakpointsParams): number[] {
  return params.breakpoints?.map(() => ++lastBreakpointId) ?? [];
}
