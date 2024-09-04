/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { GREATEST_LOWER_BOUND, LEAST_UPPER_BOUND } from '@jridgewell/trace-mapping';
import { inject, injectable } from 'inversify';
import { xxHash32 } from 'js-xxhash';
import Cdp from '../cdp/api';
import { MapUsingProjection } from '../common/datastructure/mapUsingProjection';
import { EventEmitter } from '../common/events';
import { ILogger, LogTag } from '../common/logging';
import { properResolve } from '../common/pathUtils';
import { Base01Position, Base1Position, IPosition } from '../common/positions';
import { ISourceMapMetadata, SourceMap } from '../common/sourceMaps/sourceMap';
import { CachingSourceMapFactory, ISourceMapFactory } from '../common/sourceMaps/sourceMapFactory';
import { InlineScriptOffset, ISourcePathResolver } from '../common/sourcePathResolver';
import * as sourceUtils from '../common/sourceUtils';
import * as utils from '../common/urlUtils';
import { AnyLaunchConfiguration } from '../configuration';
import Dap from '../dap/api';
import { IDapApi } from '../dap/connection';
import { sourceMapParseFailed } from '../dap/errors';
import { IInitializeParams } from '../ioc-extras';
import { IStatistics } from '../telemetry/classification';
import { extractErrorDetails } from '../telemetry/dapTelemetryReporter';
import { ensureWATExtension, IWasmSymbolProvider, IWasmSymbols } from './dwarf/wasmSymbolProvider';
import { IResourceProvider } from './resourceProvider';
import { ScriptSkipper } from './scriptSkipper/implementation';
import { IScriptSkipper } from './scriptSkipper/scriptSkipper';
import {
  ContentGetter,
  ISourceMapLocationProvider,
  ISourceScript,
  ISourceWithMap,
  isSourceWithMap,
  isSourceWithSourceMap,
  isSourceWithWasm,
  isWasmSymbols,
  IUiLocation,
  LineColumn,
  rawToUiOffset,
  Source,
  SourceFromMap,
  SourceLocationProvider,
  uiToRawOffset,
  WasmSource,
} from './source';
import { Script } from './threads';

function isUiLocation(loc: unknown): loc is IUiLocation {
  return (
    typeof (loc as IUiLocation).lineNumber === 'number'
    && typeof (loc as IUiLocation).columnNumber === 'number'
    && !!(loc as IUiLocation).source
  );
}

const getFallbackPosition = () => ({
  source: null,
  line: null,
  column: null,
  name: null,
  lastColumn: null,
  isSourceMapLoadFailure: true,
});

export type SourceMapTimeouts = {
  // This is a source map loading delay used for testing.
  load: number;

  // When resolving a location (e.g. to show it in the debug console), we wait no longer than
  // |resolveLocation| timeout for source map to be loaded, and fallback to original location
  // in the compiled source.
  resolveLocation: number;

  // When pausing before script with source map, we wait no longer than |sourceMapMinPause| timeout
  // for source map to be loaded and breakpoints to be set. This usually ensures that breakpoints
  // won't be missed.
  sourceMapMinPause: number;

  // Normally we only give each source-map sourceMapMinPause time to load per sourcemap. sourceMapCumulativePause
  // adds some additional time we spend parsing source-maps, but it's spent accross all source-maps in that // // // session
  sourceMapCumulativePause: number;

  // When sending multiple entities to debug console, we wait for each one to be asynchronously
  // processed. If one of them stalls, we resume processing others after |output| timeout.
  output: number;
};

const viteHMRPattern = /\?t=[0-9]+$/;

/** Gets whether the URL is a compiled source containing a webpack HMR */
const isHMR = (url: string) => url.endsWith('.hot-update.js') || viteHMRPattern.test(url);

const defaultTimeouts: SourceMapTimeouts = {
  load: 0,
  resolveLocation: 2000,
  sourceMapMinPause: 1000,
  output: 1000,
  sourceMapCumulativePause: 10000,
};

const isOriginalSourceOf = (compiled: Source, original: Source) =>
  original instanceof SourceFromMap
  && original.compiledToSourceUrl.has(compiled as ISourceWithMap);

export interface IPreferredUiLocation extends IUiLocation {
  isMapped: boolean;
  unmappedReason?: UnmappedReason;
}

export enum UnmappedReason {
  /** The map has been disabled temporarily, due to setting a breakpoint in a compiled script */
  MapDisabled,

  /** The source in the UI location has no map */
  HasNoMap,

  /** The location cannot be source mapped due to an error loading the map */
  MapLoadingFailed,

  /** The location cannot be source mapped due to its position not being present in the map */
  MapPositionMissing,

  /**
   * The location cannot be sourcemapped, due to not having a sourcemap,
   * failing to load the sourcemap, not having a mapping in the sourcemap, etc
   */
  CannotMap,
}

const maxInt32 = 2 ** 31 - 1;

@injectable()
export class SourceContainer {
  /**
   * Project root path, if set.
   */
  public readonly rootPaths: string[] = [];

  /**
   * Mapping of CDP script IDs to Script objects.
   */
  private readonly scriptsById: Map<Cdp.Runtime.ScriptId, Script | ISourceScript> = new Map();

  private onSourceMappedSteppingChangeEmitter = new EventEmitter<boolean>();
  private onScriptEmitter = new EventEmitter<Script>();
  private _dap: Dap.Api;
  private _sourceByOriginalUrl: Map<string, Source> = new MapUsingProjection(s => s.toLowerCase());
  private _sourceByReference: Map<number, Source> = new Map();
  private _sourceMapSourcesByUrl: Map<string, SourceFromMap> = new Map();
  private _sourceByAbsolutePath: Map<string, Source> = utils.caseNormalizedMap();

  private _sourceMapTimeouts: SourceMapTimeouts = defaultTimeouts;

  // Test support.
  _fileContentOverridesForTest = new Map<string, string>();

  /**
   * Map of sources with maps that are disabled temporarily. This can happen
   * if stepping stepping in or setting breakpoints in disabled files.
   */
  private readonly _temporarilyDisabledSourceMaps = new Set<ISourceWithMap>();

  /**
   * Map of sources with maps that are disabled for the length of the debug
   * session. This can happen if manually disabling sourcemaps for a file
   * (as a result of a missing source, for instance)
   */
  private readonly _permanentlyDisabledSourceMaps = new Set<ISourceWithMap>();

  /**
   * Fires when a new script is parsed.
   */
  public readonly onScript = this.onScriptEmitter.event;

  private readonly _statistics: IStatistics = { fallbackSourceMapCount: 0 };

  /*
   * Gets an iterator for all sources in the collection.
   */
  public get sources() {
    return this._sourceByReference.values();
  }

  /**
   * Gets statistics for telemetry
   */
  public statistics(): IStatistics {
    return this._statistics;
  }

  private _doSourceMappedStepping = this.launchConfig.sourceMaps;

  /**
   * Gets whether source stepping is enabled.
   */
  public get doSourceMappedStepping() {
    return this._doSourceMappedStepping;
  }

  /**
   * Sets whether source stepping is enabled.
   */
  public set doSourceMappedStepping(enabled: boolean) {
    if (enabled !== this._doSourceMappedStepping) {
      this._doSourceMappedStepping = enabled;
      this.onSourceMappedSteppingChangeEmitter.fire(enabled);
    }
  }

  /**
   * Fires whenever `doSourceMappedStepping` is changed.
   */
  public readonly onSourceMappedSteppingChange = this.onSourceMappedSteppingChangeEmitter.event;

  constructor(
    @inject(IDapApi) dap: Dap.Api,
    @inject(ISourceMapFactory) private readonly sourceMapFactory: ISourceMapFactory,
    @inject(ILogger) private readonly logger: ILogger,
    @inject(AnyLaunchConfiguration) private readonly launchConfig: AnyLaunchConfiguration,
    @inject(IInitializeParams) private readonly initializeConfig: Dap.InitializeParams,
    @inject(ISourcePathResolver) public readonly sourcePathResolver: ISourcePathResolver,
    @inject(IScriptSkipper) public readonly scriptSkipper: ScriptSkipper,
    @inject(IResourceProvider) private readonly resourceProvider: IResourceProvider,
    @inject(IWasmSymbolProvider) private readonly wasmSymbols: IWasmSymbolProvider,
  ) {
    this._dap = dap;

    const mainRootPath = 'webRoot' in launchConfig ? launchConfig.webRoot : launchConfig.rootPath;
    if (mainRootPath) {
      // Prefixing ../ClientApp is a workaround for a bug in ASP.NET debugging in VisualStudio because the wwwroot is not properly configured
      this.rootPaths = [mainRootPath, properResolve(mainRootPath, '..', 'ClientApp')];
    }

    scriptSkipper.setSourceContainer(this);
    this.setSourceMapTimeouts({
      ...this.sourceMapTimeouts(),
      ...launchConfig.timeouts,
    });
  }

  setSourceMapTimeouts(sourceMapTimeouts: SourceMapTimeouts) {
    this._sourceMapTimeouts = sourceMapTimeouts;
  }

  sourceMapTimeouts(): SourceMapTimeouts {
    return this._sourceMapTimeouts;
  }

  setFileContentOverrideForTest(absolutePath: string, content?: string) {
    if (content === undefined) this._fileContentOverridesForTest.delete(absolutePath);
    else this._fileContentOverridesForTest.set(absolutePath, content);
  }

  /**
   * Returns DAP objects for every loaded source in the container.
   */
  public async loadedSources(): Promise<Dap.Source[]> {
    const promises: Promise<Dap.Source>[] = [];
    for (const source of this._sourceByReference.values()) promises.push(source.toDap());
    return await Promise.all(promises);
  }

  /**
   * Gets the Source object by DAP reference, first by sourceReference and
   * then by path.
   */
  public source(ref: Dap.Source): Source | undefined {
    if (ref.sourceReference) return this._sourceByReference.get(ref.sourceReference);
    if (ref.path) return this._sourceByAbsolutePath.get(ref.path);
    return undefined;
  }

  /**
   * Gets whether the source is skipped.
   */
  public isSourceSkipped(url: string): boolean {
    return this.scriptSkipper.isScriptSkipped(url);
  }

  /**
   * Adds a new script to the source container.
   */
  public addScriptById(script: Script | ISourceScript) {
    this.scriptsById.set(script.scriptId, script);
    if ('source' in script) {
      this.onScriptEmitter.fire(script);
    }
  }

  /**
   * Gets a source script by its script ID. This includes internals scripts
   * that are not parsed to full Sources.
   */
  public getSourceScriptById(scriptId: string): ISourceScript | undefined {
    return this.scriptsById.get(scriptId);
  }

  /**
   * Gets a script by its script ID.
   */
  public getScriptById(scriptId: string): Script | undefined {
    const s = this.scriptsById.get(scriptId);
    return s && 'source' in s ? s : undefined;
  }

  /**
   * Gets a source by its original URL from the debugger.
   */
  public getSourceByOriginalUrl(url: string) {
    return this._sourceByOriginalUrl.get(url);
  }

  /**
   * Gets the source preferred source reference for a script. We generate this
   * determistically so that breakpoints have a good chance of being preserved
   * between reloads; previously, we had an incrementing source reference, but
   * this led to breakpoints being lost when the debug session got restarted.
   *
   * Note that the reference returned from this function is *only* used for
   * files that don't exist on disk; the ones that do exist always are
   * rewritten to source reference ID 0.
   */
  public getSourceReference(url: string): number {
    let id = xxHash32(url) & maxInt32; // xxHash32 is a u32, mask again the max positive int32 value

    for (let i = 0; i < 0xffff; i++) {
      if (!this._sourceByReference.has(id)) {
        return id;
      }

      if (id === maxInt32) {
        // DAP spec says max reference ID is 2^31 - 1, int32
        id = 0;
      }

      id++;
    }

    this.logger.assert(false, 'Max iterations exceeding for source reference assignment');
    return id; // conflicts, but it's better than nothing, maybe?
  }

  /**
   * This method returns a "preferred" location. This usually means going
   * through a source map and showing the source map source instead of a
   * compiled one. We use timeout to avoid waiting for the source map for too long.
   *
   * Similar to {@link getSourceMapUiLocations}, except it only returns the
   * single preferred location.
   */
  public async preferredUiLocation(uiLocation: IUiLocation): Promise<IPreferredUiLocation> {
    let isMapped = false;
    let unmappedReason: UnmappedReason | undefined = UnmappedReason.CannotMap;
    while (true) {
      const next = await this._originalPositionFor(uiLocation);
      if (!isUiLocation(next)) {
        unmappedReason = isMapped ? undefined : next;
        break;
      }

      uiLocation = next;
      isMapped = true;
      unmappedReason = undefined;
    }

    return { ...uiLocation, isMapped, unmappedReason };
  }

  /**
   * This method shows all possible locations for a given one. For example, all
   * compiled sources which refer to the same source map will be returned given
   * the location in source map source. This method does not wait for the
   * source map to be loaded.
   */
  public async currentSiblingUiLocations(
    uiLocation: IUiLocation,
    inSource?: Source,
  ): Promise<IUiLocation[]> {
    const locations = await this._uiLocations(uiLocation);
    return inSource ? locations.filter(ui => ui.source === inSource) : locations;
  }

  /**
   * Clears all sources in the container.
   * @param silent If true, does not send DAP events to remove the source; used during shutdown
   */
  public clear(silent: boolean) {
    this.scriptsById.clear();
    for (const source of this._sourceByReference.values()) {
      this.removeSource(source, silent);
    }

    this._sourceByReference.clear();
    if (this.sourceMapFactory instanceof CachingSourceMapFactory) {
      this.sourceMapFactory.invalidateCache();
    }
  }

  /**
   * Returns all the possible locations the given location can map to or from,
   * taking into account source maps.
   */
  private async _uiLocations(uiLocation: IUiLocation): Promise<IUiLocation[]> {
    const [original, source] = await Promise.all([
      this.getSourceMapUiLocations(uiLocation),
      this.getCompiledLocations(uiLocation),
    ]);

    return [...original, uiLocation, ...source];
  }

  /**
   * Returns all UI locations the given location maps to.
   *
   * Similar to {@link preferredUiLocation}, except it returns all positions,
   * not just one.
   */
  private async getSourceMapUiLocations(uiLocation: IUiLocation): Promise<IUiLocation[]> {
    const sourceMapUiLocation = await this._originalPositionFor(uiLocation);
    if (!isUiLocation(sourceMapUiLocation)) {
      return [];
    }

    const r = await this.getSourceMapUiLocations(sourceMapUiLocation);
    r.push(sourceMapUiLocation);
    return r;
  }

  /**
   * Gets the compiled position for a single UI location. Is aware of whether
   * source map stepping is enabled.
   */
  private async _originalPositionFor(uiLocation: IUiLocation) {
    if (!isSourceWithMap(uiLocation.source)) {
      return UnmappedReason.HasNoMap;
    }

    const map = await SourceLocationProvider.waitForValueWithTimeout(
      uiLocation.source.sourceMap,
      this._sourceMapTimeouts.resolveLocation,
    );
    if (!map) {
      return UnmappedReason.MapLoadingFailed;
    }

    if (this._doSourceMappedStepping) {
      return this._originalPositionForMap(uiLocation, map);
    }

    if (isWasmSymbols(map)) {
      const l = await map.disassembledPositionFor(
        new Base1Position(uiLocation.lineNumber, uiLocation.columnNumber),
      );
      const mapped = l && uiLocation.source.sourceMap.sourceByUrl.get(l.url);
      if (mapped) {
        return mapped
          ? {
            columnNumber: l.position.base1.lineNumber,
            lineNumber: l.position.base1.lineNumber,
            source: mapped,
          }
          : UnmappedReason.MapPositionMissing;
      }
    }

    return UnmappedReason.MapDisabled;
  }

  /**
   * Looks up the given location in the sourcemap.
   */
  private async _originalPositionForMap(
    uiLocation: IUiLocation,
    map: SourceMap | IWasmSymbols,
  ): Promise<IUiLocation | UnmappedReason> {
    const compiled = uiLocation.source;
    if (!isSourceWithMap(compiled)) {
      return UnmappedReason.HasNoMap;
    }

    if (
      this._temporarilyDisabledSourceMaps.has(compiled)
      || this._permanentlyDisabledSourceMaps.has(compiled)
    ) {
      return UnmappedReason.MapDisabled;
    }

    const entry = await this.getOptiminalOriginalPosition(
      map,
      rawToUiOffset(uiLocation, compiled.inlineScriptOffset),
    );

    if (!entry) {
      return UnmappedReason.MapPositionMissing;
    }

    const source = compiled.sourceMap.sourceByUrl.get(entry.url);
    if (!source) {
      return UnmappedReason.MapPositionMissing;
    }

    const base1 = entry.position.base1;
    return {
      lineNumber: base1.lineNumber,
      columnNumber: base1.columnNumber, // adjust for 0-based columns
      source: source,
    };
  }

  private async getCompiledLocations(uiLocation: IUiLocation): Promise<IUiLocation[]> {
    if (!(uiLocation.source instanceof SourceFromMap)) {
      return [];
    }

    let output: IUiLocation[] = [];
    for (const [compiled, sourceUrl] of uiLocation.source.compiledToSourceUrl) {
      const value = await SourceLocationProvider.waitForValueWithTimeout(
        compiled.sourceMap,
        this._sourceMapTimeouts.resolveLocation,
      );

      if (!value) {
        continue;
      }

      let locations: IUiLocation[];
      if ('decompiledUrl' in value) {
        const entry = await value.compiledPositionFor(
          sourceUrl,
          new Base1Position(uiLocation.lineNumber, uiLocation.columnNumber),
        );
        if (!entry) {
          continue;
        }
        locations = entry.map(l => ({
          lineNumber: l.base1.lineNumber,
          columnNumber: l.base1.columnNumber,
          source: compiled,
        }));
      } else {
        const entry = this.sourceMapFactory.guardSourceMapFn(
          value,
          () => sourceUtils.getOptimalCompiledPosition(sourceUrl, uiLocation, value),
          getFallbackPosition,
        );

        if (!entry || entry.line === null) {
          continue;
        }

        const { lineNumber, columnNumber } = uiToRawOffset(
          {
            lineNumber: entry.line || 1,
            columnNumber: (entry.column || 0) + 1, // correct for 0 index
          },
          compiled.inlineScriptOffset,
        );

        // recurse for nested sourcemaps:
        const location = { lineNumber, columnNumber, source: compiled };
        locations = [location, ...(await this.getCompiledLocations(location))];
      }

      output = output.concat(locations);
    }

    return output;
  }

  /**
   * Gets the best original position for the location in the source map.
   */
  public async getOptiminalOriginalPosition(
    sourceMap: SourceMap | IWasmSymbols,
    uiLocation: LineColumn,
  ): Promise<{ url: string; position: IPosition } | undefined> {
    if (isWasmSymbols(sourceMap)) {
      return await sourceMap.originalPositionFor(
        new Base1Position(uiLocation.lineNumber, uiLocation.columnNumber),
      );
    }
    const value = this.sourceMapFactory.guardSourceMapFn(
      sourceMap,
      () => {
        const glb = sourceMap.originalPositionFor({
          line: uiLocation.lineNumber,
          column: uiLocation.columnNumber - 1,
          bias: GREATEST_LOWER_BOUND,
        });

        if (glb.line !== null) {
          return glb;
        }

        return sourceMap.originalPositionFor({
          line: uiLocation.lineNumber,
          column: uiLocation.columnNumber - 1,
          bias: LEAST_UPPER_BOUND,
        });
      },
      getFallbackPosition,
    );

    if (value.column === null || value.line === null || value.source === null) {
      return undefined;
    }

    return {
      position: new Base01Position(value.line, value.column),
      url: value.source,
    };
  }

  /**
   * Adds a new source to the collection.
   */
  public async addSource(
    event: Cdp.Debugger.ScriptParsedEvent,
    contentGetter: ContentGetter,
    sourceMapUrl?: string,
    inlineSourceRange?: InlineScriptOffset,
    runtimeScriptOffset?: InlineScriptOffset,
    contentHash?: string,
  ): Promise<Source> {
    const absolutePath = await this.sourcePathResolver.urlToAbsolutePath({ url: event.url });

    this.logger.verbose(LogTag.RuntimeSourceCreate, 'Creating source from url', {
      inputUrl: event.url,
      absolutePath,
    });

    let source: Source;
    if (event.scriptLanguage === 'WebAssembly') {
      source = new WasmSource(this, event, absolutePath);
    } else {
      source = new Source(
        this,
        event.url,
        absolutePath,
        contentGetter,
        sourceMapUrl
          && this.sourcePathResolver.shouldResolveSourceMap({
            sourceMapUrl,
            compiledPath: absolutePath || event.url,
          })
          ? {
            sourceMapUrl,
            compiledPath: absolutePath || event.url,
            cacheKey: event.hash,
          }
          : undefined,
        inlineSourceRange,
        runtimeScriptOffset,
        contentHash,
      );
    }

    this._addSource(source);
    return source;
  }

  private async _addSource(source: Source) {
    // todo: we should allow the same source at multiple uri's if their scripts
    // have different executionContextId. We only really need the overwrite
    // behavior in Node for tools that transpile sources inline.
    const existingByUrl = source.url && this._sourceByOriginalUrl.get(source.url);
    if (existingByUrl && !isOriginalSourceOf(existingByUrl, source)) {
      this.removeSource(existingByUrl, true);
    }

    this._sourceByOriginalUrl.set(source.url, source);
    this._sourceByReference.set(source.sourceReference, source);
    if (source instanceof SourceFromMap) {
      this._sourceMapSourcesByUrl.set(source.url, source);
    }

    // Some builds, like the Vue starter, generate 'metadata' files for compiled
    // files with query strings appended to deduplicate them, or nested inside
    // of internal prefixes. If we see a duplicate entries for an absolute path,
    // take the shorter of them.
    const existingByPath = this._sourceByAbsolutePath.get(source.absolutePath);
    if (
      existingByPath === undefined
      || existingByPath.url.length >= source.url.length
      || isOriginalSourceOf(existingByPath, source)
    ) {
      this._sourceByAbsolutePath.set(source.absolutePath, source);
    }

    this.scriptSkipper.initializeSkippingValueForSource(source);
    if (!source.sendLazy) {
      this.emitLoadedSource(source);
    }

    if (isSourceWithSourceMap(source)) {
      this._finishAddSourceWithSourceMap(source);
    } else if (isSourceWithWasm(source)) {
      this._finishAddSourceWithWasm(source as WasmSource);
    }
  }

  private async _finishAddSourceWithWasm(compiled: WasmSource) {
    const symbols = await this.wasmSymbols.loadWasmSymbols(compiled.event);

    const todo: Promise<unknown>[] = [];
    for (const url of symbols.files) {
      let absolutePath: string | undefined;
      let resolvedUrl: string;
      let contentGetter: ContentGetter;
      if (url === symbols.decompiledUrl) {
        absolutePath = ensureWATExtension(compiled.absolutePath);
        resolvedUrl = ensureWATExtension(compiled.url);
        contentGetter = () => symbols.getDisassembly();
      } else {
        absolutePath = await this.sourcePathResolver.urlToAbsolutePath({ url });
        resolvedUrl = absolutePath ? utils.absolutePathToFileUrl(absolutePath) : url;
        contentGetter = () => this.resourceProvider.fetch(resolvedUrl).then(r => r.body);
      }

      this.logger.verbose(LogTag.RuntimeSourceCreate, 'Creating wasm source from source map', {
        inputUrl: url,
        absolutePath,
        resolvedUrl,
      });

      const source = new SourceFromMap(this, resolvedUrl, absolutePath, contentGetter);
      source.compiledToSourceUrl.set(compiled, url);
      compiled.sourceMap.sourceByUrl.set(url, source);
      todo.push(this._addSource(source));
    }

    await Promise.all(todo);

    compiled.sourceMap.value.resolve(symbols);
  }

  private async _finishAddSourceWithSourceMap(source: ISourceWithMap<ISourceMapLocationProvider>) {
    const deferred = source.sourceMap.value;
    let value: SourceMap | undefined;
    try {
      value = await this.sourceMapFactory.load(source.sourceMap.metadata);
    } catch (urlError) {
      if (this.initializeConfig.clientID === 'visualstudio') {
        // On VS we want to support loading source-maps from storage if the web-server doesn't serve them
        const originalSourceMapUrl = source.sourceMap.metadata.sourceMapUrl;
        try {
          const sourceMapAbsolutePath = await this.sourcePathResolver.urlToAbsolutePath({
            url: originalSourceMapUrl,
          });

          if (sourceMapAbsolutePath) {
            source.sourceMap.metadata.sourceMapUrl = utils.absolutePathToFileUrl(
              sourceMapAbsolutePath,
            );
          }

          value = await this.sourceMapFactory.load(source.sourceMap.metadata);
          this._statistics.fallbackSourceMapCount++;

          this.logger.info(
            LogTag.SourceMapParsing,
            `Failed to process original source-map; falling back to storage source-map`,
            {
              fallbackSourceMapUrl: source.sourceMap.metadata.sourceMapUrl,
              originalSourceMapUrl,
              originalSourceMapError: extractErrorDetails(urlError),
            },
          );
        } catch {}
      }

      if (value === undefined) {
        this._dap.output({
          output: sourceMapParseFailed(source.url, urlError.message).error.format + '\n',
          category: 'stderr',
        });

        return deferred.resolve(undefined);
      }
    }

    // Source map could have been detached while loading.
    if (this._sourceByReference.get(source.sourceReference) !== source) {
      return deferred.resolve(undefined);
    }

    this.logger.verbose(LogTag.SourceMapParsing, 'Creating sources from source map', {
      sourceMapId: value.id,
      metadata: value.metadata,
    });

    try {
      await this._addSourceMapSources(source, value);
    } finally {
      // important to not resolve the sourcemap until after sources are available,
      // or dependent code that's waiting for the sources will fail
      deferred.resolve(value);
    }

    // re-initialize after loading source mapped sources
    this.scriptSkipper.initializeSkippingValueForSource(source);
  }

  public removeSource(source: Source, silent = false) {
    const existing = this._sourceByReference.get(source.sourceReference);
    if (existing === undefined) {
      return; // already removed
    }

    this.logger.assert(
      source === existing,
      'Expected source to be the same as the existing reference',
    );
    this._sourceByReference.delete(source.sourceReference);

    // check for overwrites:
    if (this._sourceByOriginalUrl.get(source.url) === source) {
      this._sourceByOriginalUrl.delete(source.url);
    }

    if (source instanceof SourceFromMap) {
      this._sourceMapSourcesByUrl.delete(source.url);
      for (const [compiled, key] of source.compiledToSourceUrl) {
        compiled.sourceMap.sourceByUrl.delete(key);
      }
    }

    this._sourceByAbsolutePath.delete(source.absolutePath);
    if (isSourceWithMap(source)) {
      this._permanentlyDisabledSourceMaps.delete(source);
      this._temporarilyDisabledSourceMaps.delete(source);
    }

    if (!silent && source.hasBeenAnnounced) {
      source.toDap().then(dap => this._dap.loadedSource({ reason: 'removed', source: dap }));
    }

    if (isSourceWithWasm(source)) {
      source.sourceMap.value.promise.then(w => w?.dispose());
    }

    if (isSourceWithMap(source)) {
      this._removeSourceMapSources(source, silent);
    }
  }

  /**
   * Sends a 'loadedSource' event for the given source.
   */
  public emitLoadedSource(source: Source): Promise<void> {
    source.hasBeenAnnounced = true;
    return source.toDap().then(dap => this._dap.loadedSource({ reason: 'new', source: dap }));
  }

  async _addSourceMapSources(compiled: ISourceWithMap, map: SourceMap) {
    const todo: Promise<unknown>[] = [];
    for (const url of map.sources) {
      if (url === null) {
        continue;
      }

      const absolutePath = await this.sourcePathResolver.urlToAbsolutePath({ url, map });
      const resolvedUrl = absolutePath
        ? utils.absolutePathToFileUrl(absolutePath)
        : map.computedSourceUrl(url);

      const existing = this._sourceMapSourcesByUrl.get(resolvedUrl);
      // fix: some modules, like the current version of the 1DS SDK, managed to
      // generate self-referential sourcemaps (sourcemaps with sourcesContent that
      // have a sourceMappingUrl that refer to the same file). Avoid adding those
      // in this check.
      if (compiled === existing) {
        continue;
      }

      if (existing) {
        // In the case of an HMR, remove the old source entirely and replace it with the new one.
        if (isHMR(compiled.url)) {
          this.removeSource(existing);
        } else {
          existing.compiledToSourceUrl.set(compiled, url);
          compiled.sourceMap.sourceByUrl.set(url, existing);
          continue;
        }
      }

      this.logger.verbose(LogTag.RuntimeSourceCreate, 'Creating source from source map', {
        inputUrl: url,
        sourceMapId: map.id,
        absolutePath,
        resolvedUrl,
      });

      const fileUrl = absolutePath && utils.absolutePathToFileUrl(absolutePath);
      const smContent = this.sourceMapFactory.guardSourceMapFn(
        map,
        () => map.sourceContentFor(url),
        () => null,
      );

      let sourceMapUrl: string | undefined;
      if (smContent) {
        const rawSmUri = sourceUtils.parseSourceMappingUrl(smContent);
        if (rawSmUri) {
          const smIsDataUri = utils.isDataUri(rawSmUri);
          if (!smIsDataUri && absolutePath) {
            sourceMapUrl = utils.completeUrl(
              absolutePath ? utils.absolutePathToFileUrl(absolutePath) : url,
              rawSmUri,
            );
          } else {
            sourceMapUrl = rawSmUri;
          }
        }

        if (absolutePath && sourceMapUrl) {
          const smMetadata: ISourceMapMetadata = {
            sourceMapUrl,
            compiledPath: absolutePath,
          };

          if (!this.sourcePathResolver.shouldResolveSourceMap(smMetadata)) {
            sourceMapUrl = undefined;
          }
        }
      }

      const source = new SourceFromMap(
        this,
        resolvedUrl,
        absolutePath,
        smContent !== null
          ? () => Promise.resolve(smContent)
          : fileUrl
          ? () => this.resourceProvider.fetch(fileUrl).then(r => r.body)
          : () => compiled.content(),
        // Support recursive source maps if the source includes the source content.
        // This obviates the need for the `source-map-loader` in webpack for most cases.
        sourceMapUrl
          ? {
            compiledPath: absolutePath || resolvedUrl,
            sourceMapUrl,
            cacheKey: map.metadata.cacheKey,
          }
          : undefined,
        undefined,
        compiled.runtimeScriptOffset,
      );
      source.compiledToSourceUrl.set(compiled, url);
      compiled.sourceMap.sourceByUrl.set(url, source);
      todo.push(this._addSource(source));
    }

    await Promise.all(todo);
  }

  private _removeSourceMapSources(compiled: ISourceWithMap, silent: boolean) {
    for (const url of compiled.sourceMap.sourceByUrl.keys()) {
      const source = compiled.sourceMap.sourceByUrl.get(url);
      if (!source) {
        // Previously, we would have always expected the source to exist here.
        // However, with webpack HMR, we can unload sources that get replaced,
        // so replaced sources will no longer exist in the map.
        continue;
      }

      compiled.sourceMap.sourceByUrl.delete(url);
      source.compiledToSourceUrl.delete(compiled);
      if (source.compiledToSourceUrl.size) continue;
      this.removeSource(source, silent);
    }
  }

  // Waits for source map to be loaded (if any), and sources to be created from it.
  public async waitForSourceMapSources(source: Source): Promise<Source[]> {
    if (!isSourceWithMap(source)) {
      return [];
    }

    const sourcesByUrl = await SourceLocationProvider.waitForSources(source.sourceMap);
    return [...sourcesByUrl.values()];
  }

  /**
   * Opens the UI location within the connected editor.
   */
  public async revealUiLocation(uiLocation: IUiLocation) {
    this._dap.revealLocationRequested({
      source: await uiLocation.source.toDap(),
      line: uiLocation.lineNumber,
      column: uiLocation.columnNumber,
    });
  }

  /**
   * Disables the source map for the given source, either only until we
   * stop debugging within the file, or permanently.
   */
  public disableSourceMapForSource(source: ISourceWithMap, permanent = false) {
    if (permanent) {
      this._permanentlyDisabledSourceMaps.add(source);
    } else {
      this._temporarilyDisabledSourceMaps.add(source);
    }
  }

  /**
   * Clears temporarily disables maps for the sources.
   */
  public clearDisabledSourceMaps(forSource?: ISourceWithMap) {
    if (forSource) {
      this._temporarilyDisabledSourceMaps.delete(forSource);
    } else {
      this._temporarilyDisabledSourceMaps.clear();
    }
  }
}
