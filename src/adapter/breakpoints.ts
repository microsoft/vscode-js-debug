/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IUiLocation, SourceContainer, Source, base1To0 } from './sources';
import Dap from '../dap/api';
import Cdp from '../cdp/api';
import { Thread, Script, ScriptWithSourceMapHandler } from './threads';
import { IDisposable } from '../common/events';
import { BreakpointsPredictor } from './breakpointPredictor';
import * as urlUtils from '../common/urlUtils';
import { BreakpointsStatisticsCalculator } from '../statistics/breakpointsStatistics';
import { TelemetryEntityProperties } from '../telemetry/telemetryReporter';
import { logger, assert } from '../common/logging/logger';
import { LogTag } from '../common/logging';
import { delay } from '../common/promiseUtil';
import { MapUsingProjection } from '../common/datastructure/mapUsingProjection';
import { EntryBreakpoint } from './breakpoints/entryBreakpoint';
import { Breakpoint } from './breakpoints/breakpointBase';
import { UserDefinedBreakpoint } from './breakpoints/userDefinedBreakpoint';
import { HitCondition } from './breakpoints/hitCondition';
import { ProtocolError } from '../dap/errors';

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

export class BreakpointManager {
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

  /**
   * User-defined breakpoints by path on disk.
   */
  private _byPath: Map<string, UserDefinedBreakpoint[]> = new MapUsingProjection(
    urlUtils.lowerCaseInsensitivePath,
  );

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
    dap: Dap.Api,
    sourceContainer: SourceContainer,
    private readonly pauseForSourceMaps: boolean,
    public readonly _breakpointsPredictor?: BreakpointsPredictor,
  ) {
    this._dap = dap;
    this._sourceContainer = sourceContainer;

    this._scriptSourceMapHandler = async (script, sources) => {
      if (
        !assert(this._thread, 'Expected thread to be set for the breakpoint source map handler')
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

    for (const breakpoints of this._byPath.values()) {
      breakpoints.forEach(b => this._setBreakpoint(b, thread));
      this.ensureModuleEntryBreakpoint(thread, breakpoints[0]?._source);
    }

    for (const breakpoints of this._byRef.values()) {
      breakpoints.forEach(b => this._setBreakpoint(b, thread));
    }

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
    const mergeInto = (previous: UserDefinedBreakpoint[]): ISetBreakpointResult => {
      const result: ISetBreakpointResult = { unbound: previous.slice(), new: [], list: [] };
      if (!params.breakpoints) {
        return result;
      }

      for (let index = 0; index < params.breakpoints.length; index++) {
        const bpParams = params.breakpoints[index];

        let hitCondition: HitCondition | undefined;
        try {
          if (bpParams.hitCondition) {
            hitCondition = HitCondition.parse(bpParams.hitCondition);
          }
        } catch (e) {
          if (e instanceof ProtocolError) {
            this._dap.output({ category: 'stderr', output: e.message });
            continue;
          }
        }

        const created = new UserDefinedBreakpoint(
          this,
          ids[index],
          params.source,
          params.breakpoints[index],
          hitCondition,
        );
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
    if (thread && result.new.length) {
      // This will add itself to the launch blocker if needed:
      this.ensureModuleEntryBreakpoint(thread, params.source);

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

  /**
   * Function that should be called when breakpoints are hit. Returns whether
   * we'd like to remain paused at this point in the source, and any
   * entrypoint breakpoints that were hit.
   */
  public onBreakpointHit(hitBreakpointIds: ReadonlyArray<Cdp.Debugger.BreakpointId>) {
    // We do two things here--notify that we hit BPs for statistical purposes,
    // and see if we should automatically continue based on hit conditions. To
    // automatically continue, we need *no* breakpoints to want to continue and
    // at least one breakpoint who wants to continue. See {@link HitCondition}
    // for more details here.
    let votesForPause = 0;
    let votesForContinue = 0;
    const entrypointBps: Breakpoint[] = [];

    for (const breakpointId of hitBreakpointIds) {
      const breakpoint = this._resolvedBreakpoints.get(breakpointId);
      if (breakpoint instanceof EntryBreakpoint) {
        // we intentionally don't remove the record from the map; it's kept as
        // an indicator that it did exist and was hit, so that if further
        // breakpoints are set in the file it doesn't get re-applied.
        entrypointBps.push(breakpoint);
        breakpoint.remove();
        votesForContinue++;
        continue;
      }

      if (!(breakpoint instanceof UserDefinedBreakpoint)) {
        continue;
      }

      const id = breakpoint.dapId;
      this._breakpointsStatisticsCalculator.registerBreakpointHit(id);
      if (breakpoint.testHitCondition()) {
        votesForPause++;
      } else {
        votesForContinue++;
      }

      if (isSetAtEntry(breakpoint)) {
        entrypointBps.push(breakpoint);
      }
    }

    return {
      entrypointBps,
      remainPaused: votesForPause > 0 || votesForContinue === 0,
    };
  }

  public statisticsForTelemetry(): TelemetryEntityProperties {
    return this._breakpointsStatisticsCalculator.statistics();
  }

  /**
   * Ensures an entry breakpoint is present for the given source, creating
   * one if there's not already one.
   */
  private ensureModuleEntryBreakpoint(thread: Thread, source: Dap.Source) {
    if (!source.path || this.moduleEntryBreakpoints.has(source.path)) {
      return;
    }

    // Don't apply a custom breakpoint here if the user already has one.
    const byPath = this._byPath.get(source.path) ?? [];
    if (byPath.some(isSetAtEntry)) {
      return;
    }

    const bp = new EntryBreakpoint(this, source);
    this.moduleEntryBreakpoints.set(source.path, bp);
    this._setBreakpoint(bp, thread);
  }
}

export const kLogPointUrl = 'logpoint.cdp';

let lastBreakpointId = 0;
export function generateBreakpointIds(params: Dap.SetBreakpointsParams): number[] {
  return params.breakpoints?.map(() => ++lastBreakpointId) ?? [];
}
