/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { BreakpointManager } from '../breakpoints';
import Dap from '../../dap/api';
import { Thread, Script } from '../threads';
import Cdp from '../../cdp/api';
import { LogTag } from '../../common/logging';
import { IUiLocation, base1To0, Source, SourceFromMap } from '../sources';
import { urlToRegex, absolutePathToFileUrl } from '../../common/urlUtils';

export type LineColumn = { lineNumber: number; columnNumber: number }; // 1-based

const lcEqual = (a: Partial<LineColumn>, b: Partial<LineColumn>) =>
  a.lineNumber === b.lineNumber && a.columnNumber === b.columnNumber;

/**
 * State of the IBreakpointCdpReference.
 */
export const enum CdpReferenceState {
  // We're still working on the initial 'set breakpoint' request for this.
  Pending,
  // CDP has resolved this breakpoint to a source location locations.
  Applied,
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
  (params.url && url === params.url) || (params.urlRegex && new RegExp(params.urlRegex).test(url));

/**
 * We're currently working on sending the breakpoint to CDP.
 */
export interface IBreakpointCdpReferencePending {
  state: CdpReferenceState.Pending;
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
export interface IBreakpointCdpReferenceApplied {
  state: CdpReferenceState.Applied;
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
export type BreakpointCdpReference =
  | IBreakpointCdpReferencePending
  | Readonly<IBreakpointCdpReferenceApplied>;

export abstract class Breakpoint {
  protected isEnabled = false;

  /**
   * Returns whether this breakpoint is enabled.
   */
  public get enabled() {
    return this.isEnabled;
  }

  /**
   * Gets all CDP breakpoint IDs under which this breakpoint currently exists.
   */
  public get cdpIds(): ReadonlySet<string> {
    return this._cdpIds;
  }

  /**
   * A list of the CDP breakpoints that have been set from this one. Note that
   * this can be set, only through {@link Breakpoint#updateCdpRefs}
   */
  protected readonly cdpBreakpoints: ReadonlyArray<BreakpointCdpReference> = [];

  /**
   * Gets the source the breakpoint is set in.
   */
  public get source() {
    return this._source;
  }

  /**
   * Gets the location where the breakpoint was originally set.
   */
  public get originalPosition() {
    return this._originalPosition;
  }

  private _cdpIds = new Set<string>();

  /**
   * @param manager - Associated breakpoint manager
   * @param originalPosition - The position in the UI this breakpoint was placed at
   * @param source - Source in which this breakpoint is placed
   */
  constructor(
    protected readonly _manager: BreakpointManager,
    private _source: Dap.Source,
    private _originalPosition: LineColumn,
  ) {}

  /**
   * Updates the source location for the breakpoint. It is assumed that the
   * updated location is equivalent to the original on.  This is used to move
   * the breakpoints when we pretty print a source. This is dangerous with
   * sharp edges, use with caution.
   */
  public async updateSourceLocation(source: Dap.Source, uiLocation: IUiLocation) {
    this._source = source;
    this._originalPosition = uiLocation;

    this.updateCdpRefs(list =>
      list.map(bp =>
        bp.state === CdpReferenceState.Applied
          ? {
              ...bp,
              uiLocations: this._manager._sourceContainer.currentSiblingUiLocations(uiLocation),
            }
          : bp,
      ),
    );
  }

  /**
   * Sets the breakpoint in the provided thread and marks the "enabled" bit.
   */
  public async enable(thread: Thread): Promise<void> {
    if (this.isEnabled) {
      return;
    }

    this.isEnabled = true;
    const promises: Promise<void>[] = [this._setPredicted(thread)];
    const source = this._manager._sourceContainer.source(this.source);
    if (!source || !(source instanceof SourceFromMap)) {
      promises.push(
        // For breakpoints set before launch, we don't know whether they are in a compiled or
        // a source map source. To make them work, we always set by url to not miss compiled.
        // Additionally, if we have two sources with the same url, but different path (or no path),
        // this will make breakpoint work in all of them.
        this._setByPath(thread, this.originalPosition),
      );
    }

    if (source) {
      const uiLocations = this._manager._sourceContainer.currentSiblingUiLocations({
        lineNumber: this.originalPosition.lineNumber,
        columnNumber: this.originalPosition.columnNumber,
        source,
      });
      promises.push(...uiLocations.map(uiLocation => this._setByUiLocation(thread, uiLocation)));
    }

    await Promise.all(promises);
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

    const source = this._manager._sourceContainer.source(this.source);
    if (!source) {
      return;
    }

    this.updateCdpRefs(list =>
      list.map(bp =>
        bp.state === CdpReferenceState.Applied && bp.cdpId === cdpId
          ? {
              ...bp,
              uiLocations: [
                ...bp.uiLocations,
                ...this._manager._sourceContainer.currentSiblingUiLocations(uiLocation, source),
              ],
            }
          : bp,
      ),
    );
  }

  /**
   * Compares this breakpoint with the other. String comparison-style return:
   *  - a negative number if this breakpoint is before the other one
   *  - zero if they're the same location
   *  - a positive number if this breakpoint is after the other one
   */
  public compare(other: Breakpoint) {
    const lca = this.originalPosition;
    const lcb = other.originalPosition;
    return lca.lineNumber !== lcb.lineNumber
      ? lca.lineNumber - lcb.lineNumber
      : lca.columnNumber - lcb.columnNumber;
  }

  /**
   * Removes the breakpoint from CDP and sets the "enabled" bit to false.
   */
  public async disable(): Promise<void> {
    if (!this.isEnabled) {
      return;
    }

    this.isEnabled = false;
    const promises: Promise<unknown>[] = this.cdpBreakpoints.map(bp =>
      this.removeCdpBreakpoint(bp),
    );
    await Promise.all(promises);
  }

  public async updateForSourceMap(thread: Thread, script: Script) {
    const source = this._manager._sourceContainer.source(this.source);
    if (!source) {
      return [];
    }

    // Find all locations for this breakpoint in the new script.
    const uiLocations = this._manager._sourceContainer.currentSiblingUiLocations(
      {
        lineNumber: this.originalPosition.lineNumber,
        columnNumber: this.originalPosition.columnNumber,
        source,
      },
      await script.source,
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
    for (const bp of this.cdpBreakpoints) {
      if (isSetByUrl(bp.args) && this.breakpointIsForSource(bp.args, source)) {
        this._manager.logger.verbose(
          LogTag.RuntimeSourceMap,
          'Adjusted breakpoint due to overlaid sourcemap',
          {
            url: source.url,
          },
        );
        promises.push(this.removeCdpBreakpoint(bp));
      }
    }

    await Promise.all(promises);

    return uiLocations;
  }

  /**
   * Gets whether the breakpoint was set in the source by URL. Also checks
   * the rebased remote paths, since Sources are always normalized to the
   * 'local' locations, but the CDP set is for the remote.
   */
  private breakpointIsForSource(args: Cdp.Debugger.SetBreakpointByUrlParams, source: Source) {
    if (breakpointIsForUrl(args, source.url)) {
      return true;
    }

    const remotePath = this._manager._sourceContainer.sourcePathResolver.rebaseLocalToRemote(
      source.absolutePath(),
    );
    if (breakpointIsForUrl(args, remotePath)) {
      return true;
    }

    return false;
  }

  /**
   * Gets the condition under which this breakpoint should be hit.
   */
  protected getBreakCondition(): string | undefined {
    return undefined;
  }

  /**
   * Updates the list of CDP breakpoint references. Used to provide lifecycle
   * hooks to consumers and internal caches.
   */
  protected updateCdpRefs(
    mutator: (l: ReadonlyArray<BreakpointCdpReference>) => ReadonlyArray<BreakpointCdpReference>,
  ) {
    const cast = (this as unknown) as { cdpBreakpoints: ReadonlyArray<BreakpointCdpReference> };
    cast.cdpBreakpoints = mutator(this.cdpBreakpoints);

    const nextIdSet = new Set<string>();
    for (const bp of this.cdpBreakpoints) {
      if (bp.state === CdpReferenceState.Applied) {
        nextIdSet.add(bp.cdpId);
      }
    }

    this._cdpIds = nextIdSet;
  }

  protected async _setPredicted(thread: Thread): Promise<void> {
    if (!this.source.path || !this._manager._breakpointsPredictor) return;
    const workspaceLocations = this._manager._breakpointsPredictor.predictedResolvedLocations({
      absolutePath: this.source.path,
      lineNumber: this.originalPosition.lineNumber,
      columnNumber: this.originalPosition.columnNumber,
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

  private async _setByUiLocation(thread: Thread, uiLocation: IUiLocation): Promise<void> {
    const promises: Promise<void>[] = [];
    const scripts = thread.scriptsFromSource(uiLocation.source);
    for (const script of scripts) promises.push(this._setByScriptId(thread, script, uiLocation));
    await Promise.all(promises);
  }

  protected async _setByPath(thread: Thread, lineColumn: LineColumn): Promise<void> {
    const sourceByPath = this._manager._sourceContainer.source({ path: this.source.path });

    // If the source has been mapped in-place, don't set anything by path,
    // we'll depend only on the mapped locations.
    if (sourceByPath instanceof SourceFromMap) {
      const mappedInPlace = [...sourceByPath.compiledToSourceUrl.keys()].some(
        s => s.absolutePath() === this.source.path,
      );

      if (mappedInPlace) {
        return;
      }
    }
    const source = this._manager._sourceContainer.source(this.source);

    const url = source
      ? source.url
      : this.source.path
      ? this._manager._sourceContainer.sourcePathResolver.absolutePathToUrl(this.source.path)
      : undefined;
    if (!url) return;
    await this._setByUrl(thread, url, lineColumn);
    if (this.source.path !== url && this.source.path !== undefined) {
      await this._setByUrl(thread, absolutePathToFileUrl(this.source.path), lineColumn);
    }
  }

  /**
   * Returns whether a breakpoint has been set on the given line and column
   * at the provided script already. This is used to deduplicate breakpoint
   * requests to avoid triggering any logpoint breakpoints multiple times,
   * as would happen if we set a breakpoint both by script and URL.
   */
  protected hasSetOnLocation(script: Partial<Script>, lineColumn: LineColumn) {
    return this.cdpBreakpoints.find(
      bp =>
        (script.url &&
          isSetByUrl(bp.args) &&
          new RegExp(bp.args.urlRegex ?? '').test(script.url) &&
          lcEqual(bp.args, lineColumn)) ||
        (script.scriptId &&
          isSetByLocation(bp.args) &&
          bp.args.location.scriptId === script.scriptId &&
          lcEqual(bp.args.location, lineColumn)),
    );
  }

  protected async _setByUrl(thread: Thread, url: string, lineColumn: LineColumn): Promise<void> {
    lineColumn = base1To0(lineColumn);

    const previous = this.hasSetOnLocation({ url }, lineColumn);
    if (previous) {
      if (previous.state === CdpReferenceState.Pending) {
        await previous.done;
      }

      return;
    }

    return this._setAny(thread, {
      urlRegex: urlToRegex(url),
      condition: this.getBreakCondition(),
      ...lineColumn,
    });
  }

  private async _setByScriptId(
    thread: Thread,
    script: Script,
    lineColumn: LineColumn,
  ): Promise<void> {
    lineColumn = base1To0(lineColumn);

    // Avoid setting duplicate breakpoints
    const previous = this.hasSetOnLocation(script, lineColumn);
    if (previous) {
      if (previous.state === CdpReferenceState.Pending) {
        await previous.done;
      }

      return;
    }

    return this._setAny(thread, {
      condition: this.getBreakCondition(),
      location: {
        scriptId: script.scriptId,
        ...lineColumn,
      },
    });
  }

  /**
   * Sets a breakpoint on the thread using the given set of arguments
   * to Debugger.setBreakpoint or Debugger.setBreakpointByUrl.
   */
  protected async _setAny(thread: Thread, args: AnyCdpBreakpointArgs) {
    const state: Partial<IBreakpointCdpReferencePending> = {
      state: CdpReferenceState.Pending,
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
        state: CdpReferenceState.Applied,
        cdpId: result.breakpointId,
        args,
        locations,
        uiLocations: [],
      };
      this.updateCdpRefs(list => list.map(r => (r === state ? next : r)));
      this.updateUiLocations(thread, result.breakpointId, locations);
      return next;
    })();

    this.updateCdpRefs(list => [...list, state as IBreakpointCdpReferencePending]);
    await state.done;
  }

  /**
   * Removes a CDP breakpoint attached to this one. Deadletters it if it
   * hasn't been applied yet, deletes it immediately otherwise.
   */
  private async removeCdpBreakpoint(breakpoint: BreakpointCdpReference) {
    this.updateCdpRefs(bps => bps.filter(bp => bp !== breakpoint));
    if (breakpoint.state === CdpReferenceState.Pending) {
      breakpoint.deadletter = true;
      await breakpoint.done;
    } else {
      this._manager._resolvedBreakpoints.delete(breakpoint.cdpId);
      await this._manager._thread
        ?.cdp()
        .Debugger.removeBreakpoint({ breakpointId: breakpoint.cdpId });
    }
  }
}
