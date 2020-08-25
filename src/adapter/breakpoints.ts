/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import Cdp from '../cdp/api';
import { MapUsingProjection } from '../common/datastructure/mapUsingProjection';
import { IDisposable } from '../common/events';
import { ILogger, LogTag } from '../common/logging';
import { bisectArray, flatten } from '../common/objUtils';
import { delay } from '../common/promiseUtil';
import { SourceMap } from '../common/sourceMaps/sourceMap';
import * as urlUtils from '../common/urlUtils';
import { AnyLaunchConfiguration } from '../configuration';
import Dap from '../dap/api';
import { IDapApi } from '../dap/connection';
import { ProtocolError } from '../dap/protocolError';
import { BreakpointsStatisticsCalculator } from '../statistics/breakpointsStatistics';
import { IBreakpointPathAndId } from '../targets/targets';
import { logPerf } from '../telemetry/performance';
import { BreakpointsPredictor, IBreakpointsPredictor } from './breakpointPredictor';
import { Breakpoint } from './breakpoints/breakpointBase';
import { IBreakpointConditionFactory } from './breakpoints/conditions';
import { EntryBreakpoint } from './breakpoints/entryBreakpoint';
import { NeverResolvedBreakpoint } from './breakpoints/neverResolvedBreakpoint';
import { PatternEntryBreakpoint } from './breakpoints/patternEntrypointBreakpoint';
import { UserDefinedBreakpoint } from './breakpoints/userDefinedBreakpoint';
import {
  base0To1,
  base1To0,
  IUiLocation,
  rawToUiOffset,
  Source,
  SourceContainer,
  uiToRawOffset,
} from './sources';
import { Script, ScriptWithSourceMapHandler, Thread } from './threads';

/**
 * Differential result used internally in setBreakpoints.
 */
interface ISetBreakpointResult {
  /**
   * Breakpoints that previous existed which can be destroyed.
   */
  unbound: UserDefinedBreakpoint[];
  /**
   * Newly created breakpoints;
   */
  new: UserDefinedBreakpoint[];
  /**
   * All old and new breakpoints.
   */
  list: UserDefinedBreakpoint[];
}

const isSetAtEntry = (bp: Breakpoint) =>
  bp.originalPosition.columnNumber === 1 && bp.originalPosition.lineNumber === 1;

const breakpointSetTimeout = 500;

export type BreakpointEnableFilter = (breakpoint: Breakpoint) => boolean;

const DontCompare = Symbol('DontCompare');

/**
 * Determines the coarseness at which entry breakpoints are set.
 * @see Thread._handleWebpackModuleEval for usage information.
 */
export const enum EntryBreakpointMode {
  Exact,
  Greedy,
}

@injectable()
export class BreakpointManager {
  _dap: Dap.Api;
  _sourceContainer: SourceContainer;
  _thread: Thread | undefined;
  _disposables: IDisposable[] = [];
  _resolvedBreakpoints = new Map<Cdp.Debugger.BreakpointId, Breakpoint>();
  _totalBreakpointsCount = 0;
  _scriptSourceMapHandler: ScriptWithSourceMapHandler;
  private _launchBlocker: Set<Promise<unknown>> = new Set();
  private _predictorDisabledForTest = false;
  private _breakpointsStatisticsCalculator = new BreakpointsStatisticsCalculator();
  private readonly pauseForSourceMaps: boolean;
  private entryBreakpointMode: EntryBreakpointMode = EntryBreakpointMode.Exact;

  /**
   * Gets a flat list of all registered breakpoints.
   */
  private get allUserBreakpoints() {
    return flatten([...this._byPath.values(), ...this._byRef.values()]);
  }

  /**
   * A filter function that enables/disables breakpoints.
   */
  private _enabledFilter: BreakpointEnableFilter = () => true;

  /**
   * User-defined breakpoints by path on disk.
   */
  private _byPath: Map<string, UserDefinedBreakpoint[]> = new MapUsingProjection(
    urlUtils.lowerCaseInsensitivePath,
  );

  private _sourceMapHandlerWasUpdated = false;

  public hasAtLocation(location: IUiLocation) {
    const breakpointsAtPath = this._byPath.get(location.source.absolutePath()) || [];
    const breakpointsAtSource = this._byRef.get(location.source.sourceReference()) || [];
    return breakpointsAtPath
      .concat(breakpointsAtSource)
      .some(
        bp =>
          bp.originalPosition.columnNumber === location.columnNumber &&
          bp.originalPosition.lineNumber === location.lineNumber,
      );
  }

  /**
   * User-defined breakpoints by `sourceReference`.
   */
  private _byRef: Map<number, UserDefinedBreakpoint[]> = new Map();

  /**
   * Mapping of source paths to entrypoint breakpoint IDs we set there.
   */
  private readonly moduleEntryBreakpoints: Map<string, EntryBreakpoint> = new MapUsingProjection(
    urlUtils.lowerCaseInsensitivePath,
  );

  constructor(
    @inject(IDapApi) dap: Dap.Api,
    @inject(SourceContainer) sourceContainer: SourceContainer,
    @inject(ILogger) public readonly logger: ILogger,
    @inject(AnyLaunchConfiguration) private readonly launchConfig: AnyLaunchConfiguration,
    @inject(IBreakpointConditionFactory)
    private readonly conditionFactory: IBreakpointConditionFactory,
    @inject(IBreakpointsPredictor) public readonly _breakpointsPredictor?: BreakpointsPredictor,
  ) {
    this._dap = dap;
    this._sourceContainer = sourceContainer;
    this.pauseForSourceMaps = launchConfig.pauseForSourceMap;

    _breakpointsPredictor?.onLongParse(() => dap.longPrediction({}));

    this._scriptSourceMapHandler = async (script, sources) => {
      if (
        !logger.assert(
          this._thread,
          'Expected thread to be set for the breakpoint source map handler',
        )
      ) {
        return [];
      }

      const todo: Promise<IUiLocation[]>[] = [];

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

      return (await Promise.all(todo)).reduce((a, b) => [...a, ...b], []);
    };
  }

  /**
   * Moves all breakpoints set in the `fromSource` to their corresponding
   * location in the `toSource`, using the provided source map. Breakpoints
   * are don't have a corresponding location won't be moved.
   */
  public moveBreakpoints(fromSource: Source, sourceMap: SourceMap, toSource: Source) {
    const tryUpdateLocations = (breakpoints: UserDefinedBreakpoint[]) =>
      bisectArray(breakpoints, bp => {
        const gen = this._sourceContainer.getOptiminalOriginalPosition(
          sourceMap,
          bp.originalPosition,
        );
        if (gen.column === null || gen.line === null) {
          return false;
        }

        bp.updateSourceLocation(
          {
            path: toSource.absolutePath(),
            sourceReference: toSource.sourceReference(),
          },
          { lineNumber: gen.line, columnNumber: gen.column + 1, source: toSource },
        );
        return false;
      });

    const fromPath = fromSource.absolutePath();
    const toPath = toSource.absolutePath();
    const byPath = fromPath ? this._byPath.get(fromPath) : undefined;
    if (byPath && toPath) {
      const [remaining, moved] = tryUpdateLocations(byPath);
      this._byPath.set(fromPath, remaining);
      this._byPath.set(toPath, moved);
    }

    const byRef = this._byRef.get(fromSource.sourceReference());
    if (byRef) {
      const [remaining, moved] = tryUpdateLocations(byRef);
      this._byRef.set(fromSource.sourceReference(), remaining);
      this._byRef.set(toSource.sourceReference(), moved);
    }
  }

  /**
   * Update the entry breakpoint mode. Returns a promise that resolves
   * once all breakpoints are adjusted.
   * @see Thread._handleWebpackModuleEval for usage information.
   */
  public async updateEntryBreakpointMode(thread: Thread, mode: EntryBreakpointMode) {
    if (mode === this.entryBreakpointMode) {
      return;
    }

    const previous = [...this.moduleEntryBreakpoints.values()];
    this.moduleEntryBreakpoints.clear();
    this.entryBreakpointMode = mode;
    await Promise.all(previous.map(p => this.ensureModuleEntryBreakpoint(thread, p.source)));
  }

  /**
   * Adds and applies a filter to enable/disable breakpoints based on
   * the predicate function. If a "compare" is provided, the filter will
   * only be updated if the current filter matches the given one.
   */
  public async applyEnabledFilter(
    filter: BreakpointEnableFilter | undefined,
    compare: BreakpointEnableFilter | typeof DontCompare = DontCompare,
  ) {
    if (compare !== DontCompare && this._enabledFilter !== compare) {
      return;
    }

    this._enabledFilter = filter || (() => true);

    const thread = this._thread;
    if (!thread) {
      return;
    }

    await Promise.all(
      this.allUserBreakpoints.map(bp =>
        this._enabledFilter(bp) ? bp.enable(thread) : bp.disable(),
      ),
    );
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
      this.logger.warn(
        LogTag.Internal,
        'Expected to have the same number of start and end locations',
      );
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
        this.logger.warn(
          LogTag.Internal,
          'Expected to have the same number of start and end scripts',
        );
        continue;
      }

      // Only take the first script that matches this source. The breakpoints
      // are all coming from the same source code, so possible breakpoints
      // at one location where this source is present should match every other.
      const lsrc = start.source;
      const scripts = thread.scriptsFromSource(lsrc);
      if (scripts.size === 0) {
        continue;
      }

      const { scriptId } = scripts.values().next().value as Script;
      todo.push(
        thread
          .cdp()
          .Debugger.getPossibleBreakpoints({
            restrictToFunction: false,
            start: { scriptId, ...uiToRawOffset(base1To0(start), lsrc.runtimeScriptOffset) },
            end: { scriptId, ...uiToRawOffset(base1To0(end), lsrc.runtimeScriptOffset) },
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
              const { lineNumber, columnNumber = 0 } = location;
              const sourceLocations = this._sourceContainer.currentSiblingUiLocations(
                {
                  source: lsrc,
                  ...rawToUiOffset(
                    base0To1({ lineNumber, columnNumber }),
                    lsrc.runtimeScriptOffset,
                  ),
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
          const source = this._sourceContainer.source(breakpoint.source);
          if (source) sources.push(source);
        }
      }
      return sources;
    });

    for (const breakpoints of this._byPath.values()) {
      breakpoints.forEach(b => this._setBreakpoint(b, thread));
      this.ensureModuleEntryBreakpoint(thread, breakpoints[0]?.source);
    }

    for (const breakpoints of this._byRef.values()) {
      breakpoints.forEach(b => this._setBreakpoint(b, thread));
    }

    if (
      'runtimeSourcemapPausePatterns' in this.launchConfig &&
      this.launchConfig.runtimeSourcemapPausePatterns.length
    ) {
      this.setRuntimeSourcemapPausePatterns(
        thread,
        this.launchConfig.runtimeSourcemapPausePatterns,
      ); // will update the launchblocker
    }

    if (this._byPath.size > 0 || this._byRef.size > 0) {
      this._updateSourceMapHandler(this._thread);
    }
  }

  /**
   * Returns a promise that resolves when all breakpoints that can be set,
   * have been set. The debugger waits on this to avoid running too early
   * and missing breakpoints.
   */
  public async launchBlocker(): Promise<void> {
    logPerf(this.logger, 'BreakpointManager.launchBlocker', async () => {
      if (!this._predictorDisabledForTest) {
        await Promise.all([...this._launchBlocker]);
      }
    });
  }

  private setRuntimeSourcemapPausePatterns(thread: Thread, patterns: ReadonlyArray<string>) {
    return Promise.all(
      patterns.map(pattern =>
        this._setBreakpoint(new PatternEntryBreakpoint(this, pattern), thread),
      ),
    );
  }

  private addLaunchBlocker(...promises: ReadonlyArray<Promise<unknown>>) {
    for (const promise of promises) {
      this._launchBlocker.add(promise);
      promise.finally(() => this._launchBlocker.delete(promise));
    }
  }

  setSourceMapPauseDisabledForTest() {
    // this._sourceMapPauseDisabledForTest = disabled;
  }

  setPredictorDisabledForTest(disabled: boolean) {
    this._predictorDisabledForTest = disabled;
  }

  private _updateSourceMapHandler(thread: Thread) {
    this._sourceMapHandlerWasUpdated = true;

    if (this._breakpointsPredictor && !this.pauseForSourceMaps) {
      return thread.setScriptSourceMapHandler(false, this._scriptSourceMapHandler);
    } else {
      return thread.setScriptSourceMapHandler(true, this._scriptSourceMapHandler);
    }
  }

  private _setBreakpoint(b: Breakpoint, thread: Thread): void {
    if (!this._enabledFilter(b)) {
      return;
    }

    this.addLaunchBlocker(Promise.race([delay(breakpointSetTimeout), b.enable(thread)]));
  }

  public async setBreakpoints(
    params: Dap.SetBreakpointsParams,
    ids: number[],
  ): Promise<Dap.SetBreakpointsResult> {
    if (!this._sourceMapHandlerWasUpdated && this._thread) {
      await this._updateSourceMapHandler(this._thread);
    }

    params.source.path = urlUtils.platformPathToPreferredCase(params.source.path);

    // If we see we want to set breakpoints in file by source reference ID but
    // it doesn't exist, they were probably from a previous section. The
    // references for scripts just auto-increment per session and are entirely
    // ephemeral. Remove the reference so that we fall back to a path if possible.
    if (
      params.source.sourceReference /* not (undefined or 0=on disk) */ &&
      params.source.path &&
      !this._sourceContainer.source(params.source)
    ) {
      params.source.sourceReference = undefined;
    }

    // Wait until the breakpoint predictor finishes to be sure that we
    // can place correctly in breakpoint.set().
    if (!this._predictorDisabledForTest && this._breakpointsPredictor) {
      const promise = this._breakpointsPredictor.predictBreakpoints(params);
      this.addLaunchBlocker(promise);
      await promise;
    }

    // Creates new breakpoints for the parameters, unsetting any previous
    // breakpoints that don't still exist in the params.
    const mergeInto = (previous: UserDefinedBreakpoint[]): ISetBreakpointResult => {
      const result: ISetBreakpointResult = { unbound: previous.slice(), new: [], list: [] };
      if (!params.breakpoints) {
        return result;
      }

      for (let index = 0; index < params.breakpoints.length; index++) {
        const bpParams = params.breakpoints[index];

        let created: UserDefinedBreakpoint;
        try {
          created = new UserDefinedBreakpoint(
            this,
            ids[index],
            params.source,
            bpParams,
            this.conditionFactory.getConditionFor(bpParams),
          );
        } catch (e) {
          if (!(e instanceof ProtocolError)) {
            throw e;
          }

          this._dap.output({ category: 'stderr', output: e.message });
          created = new NeverResolvedBreakpoint(this, ids[index], params.source, bpParams);
        }

        const existingIndex = result.unbound.findIndex(p => p.equivalentTo(created));
        const existing = result.unbound[existingIndex];
        if (existing?.equivalentTo?.(created)) {
          result.list.push(existing);
          result.unbound.splice(existingIndex, 1);
        } else {
          result.new.push(created);
          result.list.push(created);
        }
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
    await Promise.all(result.unbound.map(b => b.disable()));

    this._totalBreakpointsCount += result.new.length;

    const thread = this._thread;
    if (thread && result.new.length) {
      // This will add itself to the launch blocker if needed:
      this.ensureModuleEntryBreakpoint(thread, params.source);

      const promise = Promise.all(
        result.new.filter(this._enabledFilter).map(b => b.enable(thread)),
      );
      this.addLaunchBlocker(Promise.race([delay(breakpointSetTimeout), promise]));

      await promise;
    }

    const dapBreakpoints = await Promise.all(result.list.map(b => b.toDap()));
    this._breakpointsStatisticsCalculator.registerBreakpoints(dapBreakpoints);

    // In the next task after we send the response to the adapter, mark the
    // breakpoints as having been set.
    delay(0).then(() => result.new.forEach(bp => bp.markSetCompleted()));

    return { breakpoints: dapBreakpoints };
  }

  /**
   * Gets all user-defined breakpoints
   */
  public async getBreakpoints(): Promise<Dap.GetBreakpointsResult> {
    return { breakpoints: await Promise.all(this.allUserBreakpoints.map(bp => bp.toDap())) };
  }

  /**
   * Emits a message on DAP notifying of a state update in this breakpoint.
   */
  public async notifyBreakpointChange(
    breakpoint: UserDefinedBreakpoint,
    emitChange: boolean,
  ): Promise<void> {
    const dap = await breakpoint.toDap();
    if (dap.verified) {
      this._breakpointsStatisticsCalculator.registerResolvedBreakpoint(breakpoint.dapId);
    }

    if (emitChange) {
      this._dap.breakpoint({
        reason: 'changed',
        breakpoint: dap,
      });
    }
  }

  /**
   * Rreturns whether any of the given breakpoints are an entrypoint breakpoint.
   */
  public isEntrypointBreak(hitBreakpointIds: ReadonlyArray<Cdp.Debugger.BreakpointId>) {
    return hitBreakpointIds.some(id => {
      const bp = this._resolvedBreakpoints.get(id);
      return bp && (bp instanceof EntryBreakpoint || isSetAtEntry(bp));
    });
  }

  /**
   * Handler that should be called *after* source map resolution on an entry
   * breakpoint. Returns whether the debugger should remain paused.
   */
  public async shouldPauseAt(
    pausedEvent: Cdp.Debugger.PausedEvent,
    hitBreakpointIds: ReadonlyArray<Cdp.Debugger.BreakpointId>,
    delegateEntryBreak: IBreakpointPathAndId | undefined,
    continueByDefault = false,
  ) {
    // To automatically continue, we need *no* breakpoints to want to pause and
    // at least one breakpoint who wants to continue. See
    // {@link HitCondition} for more details here.
    let votesForPause = 0;
    let votesForContinue = continueByDefault ? 1 : 0;

    await Promise.all(
      hitBreakpointIds.map(async breakpointId => {
        if (delegateEntryBreak?.cdpId === breakpointId) {
          votesForPause++;
          return;
        }

        const breakpoint = this._resolvedBreakpoints.get(breakpointId);
        if (breakpoint instanceof EntryBreakpoint) {
          // we intentionally don't remove the record from the map; it's kept as
          // an indicator that it did exist and was hit, so that if further
          // breakpoints are set in the file it doesn't get re-applied.
          if (
            this.entryBreakpointMode === EntryBreakpointMode.Exact &&
            !(breakpoint instanceof PatternEntryBreakpoint)
          ) {
            breakpoint.disable();
          }
          votesForContinue++;
          return;
        }

        if (!(breakpoint instanceof UserDefinedBreakpoint)) {
          return;
        }

        if (await breakpoint.testHitCondition(pausedEvent)) {
          votesForPause++;
        } else {
          votesForContinue++;
        }
      }),
    );

    return votesForPause > 0 || votesForContinue === 0;
  }

  /**
   * Registers that the given breakpoints were hit for statistics.
   */
  public registerBreakpointsHit(hitBreakpointIds: ReadonlyArray<Cdp.Debugger.BreakpointId>) {
    for (const breakpointId of hitBreakpointIds) {
      const breakpoint = this._resolvedBreakpoints.get(breakpointId);
      if (breakpoint instanceof UserDefinedBreakpoint) {
        this._breakpointsStatisticsCalculator.registerBreakpointHit(breakpoint.dapId);
      }
    }
  }

  public statisticsForTelemetry() {
    return this._breakpointsStatisticsCalculator.statistics();
  }

  /**
   * Ensures an entry breakpoint is present for the given source, creating
   * one if there's not already one.
   */
  private ensureModuleEntryBreakpoint(thread: Thread, source: Dap.Source) {
    if (!source.path) {
      return;
    }

    // Don't apply a custom breakpoint here if the user already has one.
    const byPath = this._byPath.get(source.path) ?? [];
    if (byPath.some(isSetAtEntry)) {
      return;
    }

    const key = EntryBreakpoint.getModeKeyForSource(this.entryBreakpointMode, source.path);
    if (!source.path || this.moduleEntryBreakpoints.has(key)) {
      return;
    }

    const bp = new EntryBreakpoint(this, source, this.entryBreakpointMode);
    this.moduleEntryBreakpoints.set(source.path, bp);
    this._setBreakpoint(bp, thread);
  }
}
