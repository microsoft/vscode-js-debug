/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import Cdp from '../cdp/api';
import { ILogger, LogTag } from '../common/logging';
import { bisectArrayAsync, flatten } from '../common/objUtils';
import { IPosition } from '../common/positions';
import { delay } from '../common/promiseUtil';
import { SourceMap } from '../common/sourceMaps/sourceMap';
import * as urlUtils from '../common/urlUtils';
import { AnyLaunchConfiguration, IChromiumBaseConfiguration } from '../configuration';
import Dap from '../dap/api';
import { IDapApi } from '../dap/connection';
import { ProtocolError } from '../dap/protocolError';
import { BreakpointsStatisticsCalculator } from '../statistics/breakpointsStatistics';
import { IBreakpointPathAndId } from '../targets/targets';
import { logPerf } from '../telemetry/performance';
import { IBreakpointsPredictor } from './breakpointPredictor';
import { Breakpoint } from './breakpoints/breakpointBase';
import { IBreakpointConditionFactory } from './breakpoints/conditions';
import { EntryBreakpoint } from './breakpoints/entryBreakpoint';
import { NeverResolvedBreakpoint } from './breakpoints/neverResolvedBreakpoint';
import { PatternEntryBreakpoint } from './breakpoints/patternEntrypointBreakpoint';
import { UserDefinedBreakpoint } from './breakpoints/userDefinedBreakpoint';
import { DiagnosticToolSuggester } from './diagnosticToolSuggester';
import { base0To1, base1To0, ISourceWithMap, isSourceWithMap, IUiLocation, Source } from './source';
import { SourceContainer } from './sourceContainer';
import { ScriptWithSourceMapHandler, Thread } from './threads';

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

export interface IPossibleBreakLocation {
  uiLocations: IUiLocation[];
  breakLocation: Cdp.Debugger.BreakLocation;
}

@injectable()
export class BreakpointManager {
  _dap: Dap.Api;
  _sourceContainer: SourceContainer;
  _thread: Thread | undefined;
  _resolvedBreakpoints = new Map<Cdp.Debugger.BreakpointId, Breakpoint>();
  _totalBreakpointsCount = 0;
  _scriptSourceMapHandler: ScriptWithSourceMapHandler;
  private _launchBlocker: Set<Promise<unknown>> = new Set();
  private _predictorDisabledForTest = false;
  private _breakpointsStatisticsCalculator = new BreakpointsStatisticsCalculator();
  private entryBreakpointMode: EntryBreakpointMode = EntryBreakpointMode.Exact;

  /**
   * A filter function that enables/disables breakpoints.
   */
  private _enabledFilter: BreakpointEnableFilter = () => true;

  /**
   * User-defined breakpoints by their DAP ID.
   */
  private readonly _byDapId = new Map<number, UserDefinedBreakpoint>();

  /**
   * User-defined breakpoints by path on disk.
   */
  private _byPath: Map<string, UserDefinedBreakpoint[]> = urlUtils.caseNormalizedMap();

  /**
   * Returns user-defined breakpoints set by ref.
   */
  public get appliedByPath(): ReadonlyMap<string, UserDefinedBreakpoint[]> {
    return this._byPath;
  }

  /**
   * Object set once the source map handler is installed. Contains a promise
   * that resolves to true/false based on whether a sourcemap instrumentation
   * breakpoint (or equivalent) was able to be set.
   */
  private _sourceMapHandlerInstalled?: { entryBpSet: Promise<boolean> };

  /**
   * User-defined breakpoints by `sourceReference`.
   */
  private _byRef: Map<number, UserDefinedBreakpoint[]> = new Map();

  /**
   * Returns user-defined breakpoints set by ref.
   */
  public get appliedByRef(): ReadonlyMap<number, UserDefinedBreakpoint[]> {
    return this._byRef;
  }

  /**
   * Mapping of source paths to entrypoint breakpoint IDs we set there.
   */
  private readonly moduleEntryBreakpoints = urlUtils.caseNormalizedMap<EntryBreakpoint>();

  constructor(
    @inject(IDapApi) dap: Dap.Api,
    @inject(SourceContainer) sourceContainer: SourceContainer,
    @inject(ILogger) public readonly logger: ILogger,
    @inject(AnyLaunchConfiguration) private readonly launchConfig: AnyLaunchConfiguration,
    @inject(IBreakpointConditionFactory) private readonly conditionFactory:
      IBreakpointConditionFactory,
    @inject(DiagnosticToolSuggester) private readonly suggester: DiagnosticToolSuggester,
    @inject(IBreakpointsPredictor) public readonly _breakpointsPredictor?: IBreakpointsPredictor,
  ) {
    this._dap = dap;
    this._sourceContainer = sourceContainer;

    _breakpointsPredictor?.onLongParse(() => dap.longPrediction({}));

    sourceContainer.onScript(script => {
      script.source.then(source => {
        const thread = this._thread;
        if (thread) {
          this._byRef
            .get(source.sourceReference)
            ?.forEach(bp => bp.updateForNewLocations(thread, script));
        }
      });
    });

    sourceContainer.onSourceMappedSteppingChange(() => {
      if (this._thread) {
        for (const bp of this._byDapId.values()) {
          bp.refreshUiLocations(this._thread);
        }
      }
    });

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
      const queue: Iterable<Source>[] = [sources];
      for (let i = 0; i < queue.length; i++) {
        for (const source of queue[i]) {
          const path = source.absolutePath;
          const byPath = path ? this._byPath.get(path) : undefined;
          for (const breakpoint of byPath || []) {
            todo.push(breakpoint.updateForNewLocations(this._thread, script));
          }
          const byRef = this._byRef.get(source.sourceReference);
          for (const breakpoint of byRef || []) {
            todo.push(breakpoint.updateForNewLocations(this._thread, script));
          }

          if (source.sourceMap) {
            queue.push(source.sourceMap.sourceByUrl.values());
          }
        }
      }

      return flatten(await Promise.all(todo));
    };
  }

  /**
   * Returns whether a breakpoint is set at the given UI location.
   */
  public hasAtLocation(location: IUiLocation) {
    const breakpointsAtPath = this._byPath.get(location.source.absolutePath) || [];
    const breakpointsAtSource = this._byRef.get(location.source.sourceReference) || [];
    return breakpointsAtPath
      .concat(breakpointsAtSource)
      .some(
        bp =>
          bp.originalPosition.columnNumber === location.columnNumber
          && bp.originalPosition.lineNumber === location.lineNumber,
      );
  }

  /**
   * Moves all breakpoints set in the `fromSource` to their corresponding
   * location in the `toSource`, using the provided source map. Breakpoints
   * are don't have a corresponding location won't be moved.
   */
  public async moveBreakpoints(
    thread: Thread,
    fromSource: Source,
    sourceMap: SourceMap,
    toSource: Source,
  ) {
    const tryUpdateLocations = (breakpoints: UserDefinedBreakpoint[]) =>
      bisectArrayAsync(breakpoints, async bp => {
        const gen = await this._sourceContainer.getOptiminalOriginalPosition(
          sourceMap,
          bp.originalPosition,
        );
        if (!gen) {
          return false;
        }

        const base1 = gen.position.base1;
        bp.updateSourceLocation(
          thread,
          {
            path: toSource.absolutePath,
            sourceReference: toSource.sourceReference,
          },
          { lineNumber: base1.lineNumber, columnNumber: base1.columnNumber, source: toSource },
        );
        return false;
      });

    const fromPath = fromSource.absolutePath;
    const toPath = toSource.absolutePath;
    const byPath = fromPath ? this._byPath.get(fromPath) : undefined;
    if (byPath && toPath) {
      const [remaining, moved] = await tryUpdateLocations(byPath);
      this._byPath.set(fromPath, remaining);
      this._byPath.set(toPath, moved);
    }

    const byRef = this._byRef.get(fromSource.sourceReference);
    if (byRef) {
      const [remaining, moved] = await tryUpdateLocations(byRef);
      this._byRef.set(fromSource.sourceReference, remaining);
      this._byRef.set(toSource.sourceReference, moved);
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
      [...this._byDapId.values()].map(bp =>
        this._enabledFilter(bp) ? bp.enable(thread) : bp.disable()
      ),
    );
  }

  /**
   * Returns possible breakpoint locations for the given range.
   */
  public async getBreakpointLocations(
    thread: Thread,
    source: Source,
    start: IPosition,
    end: IPosition,
  ) {
    const start1 = start.base1;
    const end1 = end.base1;
    const [startLocations, endLocations] = await Promise.all([
      this._sourceContainer.currentSiblingUiLocations({
        source,
        lineNumber: start1.lineNumber,
        columnNumber: start1.columnNumber,
      }),
      this._sourceContainer.currentSiblingUiLocations({
        source,
        lineNumber: end1.lineNumber,
        columnNumber: end1.columnNumber,
      }),
    ]);

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
    const todo: Promise<unknown>[] = [];
    const result: IPossibleBreakLocation[] = [];
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

      // Only take the last script that matches this source. The breakpoints
      // are all coming from the same source code, so possible breakpoints
      // at one location where this source is present should match every other.
      const lsrc = start.source;
      if (!lsrc.scripts.length) {
        continue;
      }

      const { scriptId } = lsrc.scripts[lsrc.scripts.length - 1];
      todo.push(
        thread
          .cdp()
          .Debugger.getPossibleBreakpoints({
            restrictToFunction: false,
            start: { scriptId, ...lsrc.offsetSourceToScript(base1To0(start)) },
            end: { scriptId, ...lsrc.offsetSourceToScript(base1To0(end)) },
          })
          .then(r => {
            // locations can be undefined in Hermes, #1837
            if (!r?.locations) {
              return;
            }

            // Map the locations from CDP back to their original source positions.
            // Discard any that map outside of the source we're interested in,
            // which is possible (e.g. if a section of code from one source is
            // inlined amongst the range we request).
            return Promise.all(
              r.locations.map(async breakLocation => {
                const { lineNumber, columnNumber = 0 } = breakLocation;
                const uiLocations = await this._sourceContainer.currentSiblingUiLocations({
                  source: lsrc,
                  ...lsrc.offsetScriptToSource(base0To1({ lineNumber, columnNumber })),
                });

                result.push({ breakLocation, uiLocations });
              }),
            );
          }),
      );
    }
    await Promise.all(todo);

    return result;
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
      const sources: ISourceWithMap[] = [];
      for (const id of breakpointIds) {
        const breakpoint = this._resolvedBreakpoints.get(id);
        if (breakpoint) {
          const source = this._sourceContainer.source(breakpoint.source);
          if (isSourceWithMap(source)) sources.push(source);
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
      'runtimeSourcemapPausePatterns' in this.launchConfig
      && this.launchConfig.runtimeSourcemapPausePatterns.length
    ) {
      this.setRuntimeSourcemapPausePatterns(
        thread,
        this.launchConfig.runtimeSourcemapPausePatterns,
      ); // will update the launchblocker
    }

    if (this._byDapId.size > 0) {
      this._installSourceMapHandler(this._thread);
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
        this._setBreakpoint(new PatternEntryBreakpoint(this, pattern), thread)
      ),
    );
  }

  private addLaunchBlocker(...promises: ReadonlyArray<Promise<unknown>>) {
    for (const promise of promises) {
      this._launchBlocker.add(promise);
      promise.finally(() => this._launchBlocker.delete(promise));
    }
  }

  setPredictorDisabledForTest(disabled: boolean) {
    this._predictorDisabledForTest = disabled;
  }

  private _installSourceMapHandler(thread: Thread) {
    const perScriptSm =
      (this.launchConfig as IChromiumBaseConfiguration).perScriptSourcemaps === 'yes';

    let entryBpSet: Promise<boolean>;
    if (perScriptSm) {
      entryBpSet = Promise.all([
        this.updateEntryBreakpointMode(thread, EntryBreakpointMode.Greedy),
        thread.setScriptSourceMapHandler(false, this._scriptSourceMapHandler),
      ]).then(() => true);
    } else if (this._breakpointsPredictor && !this.launchConfig.pauseForSourceMap) {
      entryBpSet = thread.setScriptSourceMapHandler(false, this._scriptSourceMapHandler);
    } else {
      entryBpSet = thread.setScriptSourceMapHandler(true, this._scriptSourceMapHandler);
    }
    this._sourceMapHandlerInstalled = { entryBpSet };
  }

  private async _uninstallSourceMapHandler(thread: Thread) {
    thread.setScriptSourceMapHandler(false);
    this._sourceMapHandlerInstalled = undefined;
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
    if (!this._sourceMapHandlerInstalled && this._thread && params.breakpoints?.length) {
      this._installSourceMapHandler(this._thread);
    }

    const wasEntryBpSet = await this._sourceMapHandlerInstalled?.entryBpSet;
    params.source.path = urlUtils.platformPathToPreferredCase(params.source.path);
    const containedSource = this._sourceContainer.source(params.source);

    // Wait until the breakpoint predictor finishes to be sure that we
    // can place correctly in breakpoint.set(), if:
    //  1) We don't have a instrumentation bp, which will be able
    //     to pause before we hit the breakpoint
    //  2) We already have loaded the source at least once in the runtime.
    //     It's possible the source can be loaded again from a different script,
    //     but we'd prefer to verify the breakpoint ASAP.
    if (!wasEntryBpSet && this._breakpointsPredictor && !containedSource) {
      const promise = this._breakpointsPredictor.predictBreakpoints(params);
      this.addLaunchBlocker(promise);
      await promise;
    }

    const thread = this._thread;
    if (thread?.debuggerReady.hasSettled() === false) {
      const promise = thread.debuggerReady.promise;
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
          this._byDapId.set(created.dapId, created);
        }
      }

      return result;
    };

    const getCurrent = () =>
      params.source.sourceReference
        ? this._byRef.get(params.source.sourceReference)
        : params.source.path
        ? this._byPath.get(params.source.path)
        : undefined;

    const result = mergeInto(getCurrent() ?? []);
    if (params.source.sourceReference) {
      this._byRef.set(params.source.sourceReference, result.list);
    } else if (params.source.path) {
      this._byPath.set(params.source.path, result.list);
    } else {
      return { breakpoints: [] };
    }

    // Ignore no-op breakpoint sets. These can come in from VS Code at the start
    // of the session (if a file only has disabled breakpoints) and make it look
    // like the user had removed all breakpoints they previously set, causing
    // us to uninstall/re-install the SM handler repeatedly.
    if (result.unbound.length === 0 && result.new.length === 0) {
      return { breakpoints: [] };
    }

    // Cleanup existing breakpoints before setting new ones.
    this._totalBreakpointsCount -= result.unbound.length;
    await Promise.all(
      result.unbound.map(b => {
        this._byDapId.delete(b.dapId);
        return b.disable();
      }),
    );

    this._totalBreakpointsCount += result.new.length;

    if (this._thread) {
      if (this._totalBreakpointsCount === 0 && this._sourceMapHandlerInstalled) {
        this._uninstallSourceMapHandler(this._thread);
      } else if (this._totalBreakpointsCount > 0 && !this._sourceMapHandlerInstalled) {
        this._installSourceMapHandler(this._thread);
      }
    }

    if (thread && result.new.length) {
      // This will add itself to the launch blocker if needed:
      this.ensureModuleEntryBreakpoint(thread, params.source);

      // double-checking the current list fixes:
      // https://github.com/microsoft/vscode-js-debug/issues/679
      const currentList = getCurrent();
      const promise = Promise.all(
        result.new
          .filter(this._enabledFilter)
          .filter(bp => currentList?.includes(bp))
          .map(b => b.enable(thread)),
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
   * Emits a message on DAP notifying of a state update in this breakpoint.
   */
  public async notifyBreakpointChange(
    breakpoint: UserDefinedBreakpoint,
    emitChange: boolean,
  ): Promise<void> {
    // check if it was removed (#1406)
    if (!this._byDapId.has(breakpoint.dapId)) {
      return;
    }

    const dap = await breakpoint.toDap();
    if (dap.verified) {
      this._breakpointsStatisticsCalculator.registerResolvedBreakpoint(breakpoint.dapId);
      this.suggester.notifyVerifiedBreakpoint();
    }

    if (emitChange) {
      this._dap.breakpoint({
        reason: 'changed',
        breakpoint: dap,
      });
    }
  }

  /**
   * Returns whether any of the given breakpoints are an entrypoint breakpoint.
   */
  public isEntrypointBreak(
    hitBreakpointIds: ReadonlyArray<Cdp.Debugger.BreakpointId>,
    scriptId: string,
  ) {
    // Fix: if we stopped in a script where an active entrypoint breakpoint
    // exists, regardless of the reason, treat this as a breakpoint.
    // ref: https://github.com/microsoft/vscode/issues/107859
    const entryInScript = [...this.moduleEntryBreakpoints.values()].some(
      bp => bp.enabled && bp.cdpScriptIds.has(scriptId),
    );

    if (entryInScript) {
      return true;
    }

    return hitBreakpointIds.some(id => {
      const bp = this._resolvedBreakpoints.get(id);
      return bp && (bp instanceof EntryBreakpoint || isSetAtEntry(bp));
    });
  }

  /** Gets whether the CDP breakpoint ID refers to an entrypoint breakpoint. */
  public isEntrypointCdpBreak(cdpId: string) {
    const bp = this._resolvedBreakpoints.get(cdpId);
    return bp instanceof EntryBreakpoint;
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
    if (!hitBreakpointIds.length) {
      return pausedEvent.reason !== 'instrumentation';
    }

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
            this.entryBreakpointMode === EntryBreakpointMode.Exact
            && !(breakpoint instanceof PatternEntryBreakpoint)
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

  /**
   * Should be called when the execution context is cleared. Breakpoints set
   * on a script ID will no longer be bound correctly.
   */
  public executionContextWasCleared() {
    for (const bp of this._byDapId.values()) {
      bp.executionContextWasCleared();
    }
  }

  /**
   * Reapplies any currently-set user defined breakpoints.
   */
  public async reapply() {
    const all = [...this._byDapId.values()];
    await Promise.all(all.map(a => a.disable()));
    if (this._thread) {
      const thread = this._thread;
      await Promise.all(all.map(a => a.enable(thread)));
    }
  }
}
