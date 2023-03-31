/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { inject, injectable } from 'inversify';
import { xxHash32 } from 'js-xxhash';
import { relative } from 'path';
import { NullableMappedPosition, SourceMapConsumer } from 'source-map';
import { URL } from 'url';
import Cdp from '../cdp/api';
import { MapUsingProjection } from '../common/datastructure/mapUsingProjection';
import { EventEmitter } from '../common/events';
import { checkContentHash } from '../common/hash/checkContentHash';
import { ILogger, LogTag } from '../common/logging';
import { once } from '../common/objUtils';
import { forceForwardSlashes, isSubdirectoryOf, properResolve } from '../common/pathUtils';
import { delay, getDeferred } from '../common/promiseUtil';
import { ISourceMapMetadata, SourceMap } from '../common/sourceMaps/sourceMap';
import { CachingSourceMapFactory, ISourceMapFactory } from '../common/sourceMaps/sourceMapFactory';
import { ISourcePathResolver, InlineScriptOffset } from '../common/sourcePathResolver';
import * as sourceUtils from '../common/sourceUtils';
import { prettyPrintAsSourceMap } from '../common/sourceUtils';
import * as utils from '../common/urlUtils';
import { AnyLaunchConfiguration } from '../configuration';
import Dap from '../dap/api';
import { IDapApi } from '../dap/connection';
import { sourceMapParseFailed } from '../dap/errors';
import { IInitializeParams } from '../ioc-extras';
import { IStatistics } from '../telemetry/classification';
import { extractErrorDetails } from '../telemetry/dapTelemetryReporter';
import { IResourceProvider } from './resourceProvider';
import { ScriptSkipper } from './scriptSkipper/implementation';
import { IScriptSkipper } from './scriptSkipper/scriptSkipper';
import { Script } from './threads';

// This is a ui location which corresponds to a position in the document user can see (Source, Dap.Source).
export interface IUiLocation {
  lineNumber: number; // 1-based
  columnNumber: number; // 1-based
  source: Source;
}

function isUiLocation(loc: unknown): loc is IUiLocation {
  return (
    typeof (loc as IUiLocation).lineNumber === 'number' &&
    typeof (loc as IUiLocation).columnNumber === 'number' &&
    !!(loc as IUiLocation).source
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

type ContentGetter = () => Promise<string | undefined>;

// Each source map has a number of compiled sources referncing it.
type SourceMapData = { compiled: Set<ISourceWithMap>; map?: SourceMap; loaded: Promise<void> };
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

/** Gets whether the URL is a compiled source containing a webpack HMR */
const isWebpackHMR = (url: string) => url.endsWith('.hot-update.js');

const defaultTimeouts: SourceMapTimeouts = {
  load: 0,
  resolveLocation: 2000,
  sourceMapMinPause: 1000,
  output: 1000,
  sourceMapCumulativePause: 10000,
};

export interface ISourceScript {
  executionContextId: Cdp.Runtime.ExecutionContextId;
  scriptId: Cdp.Runtime.ScriptId;
  url: string;
}

// Represents a text source visible to the user.
//
// Source maps flow (start with compiled1 and compiled2). Two different compiled sources
// reference to the same source map, and produce two different resolved urls leading
// to different source map sources. This is a corner case, usually there is a single
// resolved url and a single source map source per each sourceUrl in the source map.
//
//       ------> sourceMapUrl -> SourceContainer._sourceMaps -> SourceMapData -> map
//       |    |                                                                    |
//       |    compiled1  - - - - - - -  source1 <-- resolvedUrl1 <-- sourceUrl <----
//       |                                                                         |
//      compiled2  - - - - - - - - - -  source2 <-- resolvedUrl2 <-- sourceUrl <----
//
// compiled1 and source1 are connected (same goes for compiled2 and source2):
//    compiled1._sourceMapSourceByUrl.get(sourceUrl) === source1
//    source1._compiledToSourceUrl.get(compiled1) === sourceUrl
//
export class Source {
  public readonly sourceReference: number;
  private readonly _name: string;
  private readonly _fqname: string;

  /**
   * Function to retrieve the content of the source.
   */
  private readonly _contentGetter: ContentGetter;

  private readonly _container: SourceContainer;

  /**
   * Hypothesized absolute path for the source. May or may not actually exist.
   */
  public readonly absolutePath: string;

  public sourceMap?: ISourceWithMap['sourceMap'];

  // This is the same as |_absolutePath|, but additionally checks that file exists to
  // avoid errors when page refers to non-existing paths/urls.
  private readonly _existingAbsolutePath: Promise<string | undefined>;
  private _scripts: ISourceScript[] = [];

  /**
   * @param inlineScriptOffset Offset of the start location of the script in
   * its source file. This is used on scripts in HTML pages, where the script
   * is nested in the content.
   * @param contentHash Optional hash of the file contents. This is used to
   * check whether the script we get is the same one as what's on disk. This
   * can be used to detect in-place transpilation.
   * @param runtimeScriptOffset Offset of the start location of the script
   * in the runtime *only*. This differs from the inlineScriptOffset, as the
   * inline offset of also reflected in the file. This is used to deal with
   * the runtime wrapping the source and offsetting locations which should
   * not be shown to the user.
   */
  constructor(
    container: SourceContainer,
    public readonly url: string,
    absolutePath: string | undefined,
    contentGetter: ContentGetter,
    sourceMapUrl?: string,
    public readonly inlineScriptOffset?: InlineScriptOffset,
    public readonly runtimeScriptOffset?: InlineScriptOffset,
    public readonly contentHash?: string,
  ) {
    this.sourceReference = container.getSourceReference(url);
    this._contentGetter = once(contentGetter);
    this._container = container;
    this.absolutePath = absolutePath || '';
    this._fqname = this._fullyQualifiedName();
    this._name = this._humanName();
    this.setSourceMapUrl(sourceMapUrl);

    this._existingAbsolutePath = checkContentHash(
      this.absolutePath,
      // Inline scripts will never match content of the html file. We skip the content check.
      inlineScriptOffset || runtimeScriptOffset ? undefined : contentHash,
      container._fileContentOverridesForTest.get(this.absolutePath),
    );
  }

  private setSourceMapUrl(sourceMapUrl?: string) {
    if (!sourceMapUrl) {
      this.sourceMap = undefined;
      return;
    }

    this.sourceMap = {
      url: sourceMapUrl,
      sourceByUrl: new Map(),
      metadata: {
        sourceMapUrl,
        compiledPath: this.absolutePath || this.url,
      },
    };
  }

  /**
   * Associated a script with this source. This is only valid for a source
   * from the runtime, not a {@link SourceFromMap}.
   */
  addScript(script: ISourceScript): void {
    this._scripts.push(script);
  }

  /**
   * Filters scripts from a source, done when an execution context is removed.
   */
  filterScripts(fn: (s: ISourceScript) => boolean): void {
    this._scripts = this._scripts.filter(fn);
  }

  /**
   * Gets scripts associated with this source.
   */
  get scripts(): ReadonlyArray<ISourceScript> {
    return this._scripts;
  }

  /**
   * Gets a suggested mimetype for the source.
   */
  get getSuggestedMimeType(): string | undefined {
    // only return an explicit mimetype if the file has no extension (such as
    // with node internals.) Otherwise, let the editor guess.
    if (!/\.[^/]+$/.test(this.url)) {
      return 'text/javascript';
    }
  }

  async content(): Promise<string | undefined> {
    let content = await this._contentGetter();

    // pad for the inline source offset, see
    // https://github.com/microsoft/vscode-js-debug/issues/736
    if (this.inlineScriptOffset?.lineOffset) {
      content = '\n'.repeat(this.inlineScriptOffset.lineOffset) + content;
    }

    return content;
  }

  /**
   * Pretty-prints the source. Generates a beauitified source map if possible
   * and it hasn't already been done, and returns the created map and created
   * ephemeral source. Returns undefined if the source can't be beautified.
   */
  public async prettyPrint(): Promise<{ map: SourceMap; source: Source } | undefined> {
    if (!this._container) {
      return undefined;
    }

    if (isSourceWithMap(this) && this.sourceMap.url.endsWith('-pretty.map')) {
      const map = this._container._sourceMaps.get(this.sourceMap?.url)?.map;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return map && { map, source: [...this.sourceMap.sourceByUrl!.values()][0] };
    }

    const content = await this.content();
    if (!content) {
      return undefined;
    }

    // Eval'd scripts have empty urls, give them a temporary one for the purpose
    // of the sourcemap. See #929
    const baseUrl = this.url || `eval://${this.sourceReference}.js`;
    const sourceMapUrl = baseUrl + '-pretty.map';
    const basename = baseUrl.split(/[\/\\]/).pop() as string;
    const fileName = basename + '-pretty.js';
    const map = await prettyPrintAsSourceMap(fileName, content, baseUrl, sourceMapUrl);
    if (!map) {
      return undefined;
    }

    // Note: this overwrites existing source map.
    this.setSourceMapUrl(sourceMapUrl);
    const asCompiled = this as ISourceWithMap;
    const sourceMap: SourceMapData = {
      compiled: new Set([asCompiled]),
      map,
      loaded: Promise.resolve(),
    };
    this._container._sourceMaps.set(sourceMapUrl, sourceMap);
    await this._container._addSourceMapSources(asCompiled, map);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return { map, source: [...asCompiled.sourceMap.sourceByUrl.values()][0] };
  }

  /**
   * Returns a DAP representation of the source.
   */
  async toDap(): Promise<Dap.Source> {
    return this.toDapShallow();
  }

  /**
   * Returns a DAP representation without including any nested sources.
   */
  public async toDapShallow(): Promise<Dap.Source> {
    const existingAbsolutePath = await this._existingAbsolutePath;
    const dap: Dap.Source = {
      name: this._name,
      path: this._fqname,
      sourceReference: this.sourceReference,
      presentationHint: this.blackboxed() ? 'deemphasize' : undefined,
      origin: this.blackboxed() ? l10n.t('Skipped by skipFiles') : undefined,
    };

    if (existingAbsolutePath) {
      dap.sourceReference = 0;
      dap.path = existingAbsolutePath;
    }

    return dap;
  }

  existingAbsolutePath(): Promise<string | undefined> {
    return this._existingAbsolutePath;
  }

  async prettyName(): Promise<string> {
    const path = await this._existingAbsolutePath;
    if (path) return path;
    return this._fqname;
  }

  /**
   * Gets the human-readable name of the source.
   */
  private _humanName() {
    if (utils.isAbsolute(this._fqname)) {
      for (const root of this._container.rootPaths) {
        if (isSubdirectoryOf(root, this._fqname)) {
          return forceForwardSlashes(relative(root, this._fqname));
        }
      }
    }

    return this._fqname;
  }

  /**
   * Returns a pretty name for the script. This is the name displayed in
   * stack traces and returned through DAP if the file does not verifiably
   * exist on disk.
   */
  private _fullyQualifiedName(): string {
    if (!this.url) {
      return '<eval>/VM' + this.sourceReference;
    }

    if (this.url.endsWith(sourceUtils.SourceConstants.ReplExtension)) {
      return 'repl';
    }

    if (this.absolutePath.startsWith('<node_internals>')) {
      return this.absolutePath;
    }

    if (utils.isAbsolute(this.url)) {
      return this.url;
    }

    const parsedAbsolute = utils.fileUrlToAbsolutePath(this.url);
    if (parsedAbsolute) {
      return parsedAbsolute;
    }

    let fqname = this.url;
    try {
      const tokens: string[] = [];
      const url = new URL(this.url);
      if (url.protocol === 'data:') {
        return '<eval>/VM' + this.sourceReference;
      }

      if (url.hostname) {
        tokens.push(url.hostname);
      }

      if (url.port) {
        tokens.push('\uA789' + url.port); // : in unicode
      }

      if (url.pathname) {
        tokens.push(/^\/[a-z]:/.test(url.pathname) ? url.pathname.slice(1) : url.pathname);
      }

      const searchParams = url.searchParams?.toString();
      if (searchParams) {
        tokens.push('?' + searchParams);
      }

      fqname = tokens.join('');
    } catch (e) {
      // ignored
    }

    if (fqname.endsWith('/')) {
      fqname += '(index)';
    }

    if (this.inlineScriptOffset) {
      fqname += `\uA789${this.inlineScriptOffset.lineOffset + 1}:${
        this.inlineScriptOffset.columnOffset + 1
      }`;
    }
    return fqname;
  }

  /**
   * Gets whether this script is blackboxed (part of the skipfiles).
   */
  public blackboxed(): boolean {
    return this._container.isSourceSkipped(this.url);
  }
}

/**
 * A Source that has an associated sourcemap.
 */
export interface ISourceWithMap extends Source {
  readonly sourceMap: {
    url: string;
    metadata: ISourceMapMetadata;
    // When compiled source references a source map, we'll generate source map sources.
    // This map |sourceUrl| as written in the source map itself to the Source.
    // Only present on compiled sources, exclusive with |_origin|.
    sourceByUrl: Map<string, SourceFromMap>;
  };
}

/**
 * A Source generated from a sourcemap. For example, a TypeScript input file
 * discovered from its compiled JavaScript code.
 */
export class SourceFromMap extends Source {
  // Sources generated from the source map are referenced by some compiled sources
  // (through a source map). This map holds the original |sourceUrl| as written in the
  // source map, which was used to produce this source for each compiled.
  public readonly compiledToSourceUrl = new Map<ISourceWithMap, string>();
}

export const isSourceWithMap = (source: unknown): source is ISourceWithMap =>
  !!source && source instanceof Source && !!source.sourceMap;

const isOriginalSourceOf = (compiled: Source, original: Source) =>
  original instanceof SourceFromMap && original.compiledToSourceUrl.has(compiled as ISourceWithMap);

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
  private readonly scriptsById: Map<Cdp.Runtime.ScriptId, Script> = new Map();

  private onSourceMappedSteppingChangeEmitter = new EventEmitter<boolean>();
  private onScriptEmitter = new EventEmitter<Script>();
  private _dap: Dap.Api;
  private _sourceByOriginalUrl: Map<string, Source> = new MapUsingProjection(s => s.toLowerCase());
  private _sourceByReference: Map<number, Source> = new Map();
  private _sourceMapSourcesByUrl: Map<string, SourceFromMap> = new Map();
  private _sourceByAbsolutePath: Map<string, Source> = utils.caseNormalizedMap();

  // All source maps by url.
  _sourceMaps: Map<string, SourceMapData> = new Map();
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
  public addScriptById(script: Script) {
    this.scriptsById.set(script.scriptId, script);
    this.onScriptEmitter.fire(script);
  }

  /**
   * Gets a script by its script ID.
   */
  public getScriptById(scriptId: string) {
    return this.scriptsById.get(scriptId);
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
   */
  public async preferredUiLocation(uiLocation: IUiLocation): Promise<IPreferredUiLocation> {
    let isMapped = false;
    let unmappedReason: UnmappedReason | undefined = UnmappedReason.CannotMap;
    if (this._doSourceMappedStepping) {
      while (true) {
        if (!isSourceWithMap(uiLocation.source)) {
          break;
        }

        const sourceMap = this._sourceMaps.get(uiLocation.source.sourceMap.url);
        if (
          !this.logger.assert(
            sourceMap,
            `Expected to have sourcemap for loaded source ${uiLocation.source.sourceMap.url}`,
          )
        ) {
          break;
        }

        await Promise.race([sourceMap.loaded, delay(this._sourceMapTimeouts.resolveLocation)]);
        if (!sourceMap.map) return { ...uiLocation, isMapped, unmappedReason };
        const sourceMapped = this._sourceMappedUiLocation(uiLocation, sourceMap.map);
        if (!isUiLocation(sourceMapped)) {
          unmappedReason = isMapped ? undefined : sourceMapped;
          break;
        }

        uiLocation = sourceMapped;
        isMapped = true;
        unmappedReason = undefined;
      }
    }

    return { ...uiLocation, isMapped, unmappedReason };
  }

  /**
   * This method shows all possible locations for a given one. For example, all
   * compiled sources which refer to the same source map will be returned given
   * the location in source map source. This method does not wait for the
   * source map to be loaded.
   */
  currentSiblingUiLocations(uiLocation: IUiLocation, inSource?: Source): IUiLocation[] {
    return this._uiLocations(uiLocation).filter(
      uiLocation => !inSource || uiLocation.source === inSource,
    );
  }

  /**
   * Clears all sources in the container.
   */
  clear(silent: boolean) {
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
  private _uiLocations(uiLocation: IUiLocation): IUiLocation[] {
    return [
      ...this.getSourceMapUiLocations(uiLocation),
      uiLocation,
      ...this.getCompiledLocations(uiLocation),
    ];
  }

  /**
   * Returns all UI locations the given location maps to.
   */
  private getSourceMapUiLocations(uiLocation: IUiLocation): IUiLocation[] {
    if (!isSourceWithMap(uiLocation.source) || !this._doSourceMappedStepping) return [];
    const map = this._sourceMaps.get(uiLocation.source.sourceMap.url)?.map;
    if (!map) return [];
    const sourceMapUiLocation = this._sourceMappedUiLocation(uiLocation, map);
    if (!isUiLocation(sourceMapUiLocation)) return [];

    const r = this.getSourceMapUiLocations(sourceMapUiLocation);
    r.push(sourceMapUiLocation);
    return r;
  }

  private _sourceMappedUiLocation(
    uiLocation: IUiLocation,
    map: SourceMap,
  ): IUiLocation | UnmappedReason {
    const compiled = uiLocation.source;
    if (!isSourceWithMap(compiled)) {
      return UnmappedReason.HasNoMap;
    }

    if (
      this._temporarilyDisabledSourceMaps.has(compiled) ||
      this._permanentlyDisabledSourceMaps.has(compiled)
    ) {
      return UnmappedReason.MapDisabled;
    }

    const entry = this.getOptiminalOriginalPosition(
      map,
      rawToUiOffset(uiLocation, compiled.inlineScriptOffset),
    );

    if ('isSourceMapLoadFailure' in entry) {
      return UnmappedReason.MapLoadingFailed;
    }

    if (!entry.source) {
      return UnmappedReason.MapPositionMissing;
    }

    const source = compiled.sourceMap.sourceByUrl.get(entry.source);
    if (!source) {
      return UnmappedReason.MapPositionMissing;
    }

    return {
      lineNumber: entry.line || 1,
      columnNumber: entry.column ? entry.column + 1 : 1, // adjust for 0-based columns
      source: source,
    };
  }

  private getCompiledLocations(uiLocation: IUiLocation): IUiLocation[] {
    if (!(uiLocation.source instanceof SourceFromMap)) {
      return [];
    }

    let output: IUiLocation[] = [];
    for (const [compiled, sourceUrl] of uiLocation.source.compiledToSourceUrl) {
      const sourceMap = this._sourceMaps.get(compiled.sourceMap.url);
      if (!sourceMap || !sourceMap.map) {
        continue;
      }

      const entry = this.sourceMapFactory.guardSourceMapFn(
        sourceMap.map,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        () => sourceUtils.getOptimalCompiledPosition(sourceUrl, uiLocation, sourceMap.map!),
        getFallbackPosition,
      );

      if (!entry) {
        continue;
      }

      const { lineNumber, columnNumber } = uiToRawOffset(
        {
          lineNumber: entry.line || 1,
          columnNumber: (entry.column || 0) + 1, // correct for 0 index
        },
        compiled.inlineScriptOffset,
      );

      const compiledUiLocation: IUiLocation = {
        lineNumber,
        columnNumber,
        source: compiled,
      };

      output = output.concat(compiledUiLocation, this.getCompiledLocations(compiledUiLocation));
    }

    return output;
  }

  /**
   * Gets the best original position for the location in the source map.
   */
  public getOptiminalOriginalPosition(sourceMap: SourceMap, uiLocation: LineColumn) {
    return this.sourceMapFactory.guardSourceMapFn<NullableMappedPosition>(
      sourceMap,
      () => {
        const glb = sourceMap.originalPositionFor({
          line: uiLocation.lineNumber,
          column: uiLocation.columnNumber - 1,
          bias: SourceMapConsumer.GREATEST_LOWER_BOUND,
        });

        if (glb.line !== null) {
          return glb;
        }

        return sourceMap.originalPositionFor({
          line: uiLocation.lineNumber,
          column: uiLocation.columnNumber - 1,
          bias: SourceMapConsumer.LEAST_UPPER_BOUND,
        });
      },
      getFallbackPosition,
    );
  }

  /**
   * Adds a new source to the collection.
   */
  public async addSource(
    url: string,
    contentGetter: ContentGetter,
    sourceMapUrl?: string,
    inlineSourceRange?: InlineScriptOffset,
    runtimeScriptOffset?: InlineScriptOffset,
    contentHash?: string,
  ): Promise<Source> {
    const absolutePath = await this.sourcePathResolver.urlToAbsolutePath({ url });

    this.logger.verbose(LogTag.RuntimeSourceCreate, 'Creating source from url', {
      inputUrl: url,
      absolutePath,
    });

    const source = new Source(
      this,
      url,
      absolutePath,
      contentGetter,
      sourceMapUrl &&
      this.sourcePathResolver.shouldResolveSourceMap({
        sourceMapUrl,
        compiledPath: absolutePath || url,
      })
        ? sourceMapUrl
        : undefined,
      inlineSourceRange,
      runtimeScriptOffset,
      contentHash,
    );

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
      existingByPath === undefined ||
      existingByPath.url.length >= source.url.length ||
      isOriginalSourceOf(existingByPath, source)
    ) {
      this._sourceByAbsolutePath.set(source.absolutePath, source);
    }

    this.scriptSkipper.initializeSkippingValueForSource(source);
    source.toDap().then(dap => this._dap.loadedSource({ reason: 'new', source: dap }));

    if (!isSourceWithMap(source)) {
      return;
    }

    const existingSourceMap = this._sourceMaps.get(source.sourceMap.url);
    if (existingSourceMap) {
      existingSourceMap.compiled.add(source);
      if (existingSourceMap.map) {
        // If source map has been already loaded, we add sources here.
        // Otheriwse, we'll add sources for all compiled after loading the map.
        await this._addSourceMapSources(source, existingSourceMap.map);
      }
      return;
    }

    const deferred = getDeferred<void>();
    const sourceMap: SourceMapData = { compiled: new Set([source]), loaded: deferred.promise };
    this._sourceMaps.set(source.sourceMap.url, sourceMap);

    try {
      sourceMap.map = await this.sourceMapFactory.load(source.sourceMap.metadata);
    } catch (urlError) {
      if (this.initializeConfig.clientID === 'visualstudio') {
        // On VS we want to support loading source-maps from storage if the web-server doesn't serve them
        const originalSourceMapUrl = source.sourceMap.metadata.sourceMapUrl;
        try {
          const sourceMapAbsolutePath = await this.sourcePathResolver.urlToAbsolutePath({
            url: originalSourceMapUrl,
          });

          if (sourceMapAbsolutePath) {
            source.sourceMap.metadata.sourceMapUrl =
              utils.absolutePathToFileUrl(sourceMapAbsolutePath);
          }

          sourceMap.map = await this.sourceMapFactory.load(source.sourceMap.metadata);
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

      if (!sourceMap.map) {
        this._dap.output({
          output: sourceMapParseFailed(source.url, urlError.message).error.format + '\n',
          category: 'stderr',
        });

        return deferred.resolve();
      }
    }

    // Source map could have been detached while loading.
    if (this._sourceMaps.get(source.sourceMap.url) !== sourceMap) {
      return deferred.resolve();
    }

    this.logger.verbose(LogTag.SourceMapParsing, 'Creating sources from source map', {
      sourceMapId: sourceMap.map.id,
      metadata: sourceMap.map.metadata,
    });

    const todo: Promise<void>[] = [];
    for (const compiled of sourceMap.compiled) {
      todo.push(this._addSourceMapSources(compiled, sourceMap.map));
    }

    await Promise.all(todo);

    // re-initialize after loading source mapped sources
    this.scriptSkipper.initializeSkippingValueForSource(source);
    deferred.resolve();
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

    if (!silent) {
      source.toDap().then(dap => this._dap.loadedSource({ reason: 'removed', source: dap }));
    }

    if (!isSourceWithMap(source)) return;

    const sourceMap = this._sourceMaps.get(source.sourceMap.url);
    if (
      !this.logger.assert(
        sourceMap,
        `Source map missing for ${source.sourceMap.url} in removeSource()`,
      )
    ) {
      return;
    }
    this.logger.assert(
      sourceMap.compiled.has(source),
      `Source map ${source.sourceMap.url} does not contain source ${source.url}`,
    );

    sourceMap.compiled.delete(source);
    if (!sourceMap.compiled.size) {
      if (sourceMap.map) sourceMap.map.destroy();
      this._sourceMaps.delete(source.sourceMap.url);
    }
    // Source map could still be loading, or failed to load.
    if (sourceMap.map) {
      this._removeSourceMapSources(source, sourceMap.map, silent);
    }
  }

  async _addSourceMapSources(compiled: ISourceWithMap, map: SourceMap) {
    const todo: Promise<unknown>[] = [];
    for (const url of map.sources) {
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
        // In the case of a Webpack HMR, remove the old source entirely and
        // replace it with the new one.
        if (isWebpackHMR(compiled.url)) {
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
        () => map.sourceContentFor(url, true),
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
        sourceMapUrl,
        undefined,
        compiled.runtimeScriptOffset,
      );
      source.compiledToSourceUrl.set(compiled, url);
      compiled.sourceMap.sourceByUrl.set(url, source);
      todo.push(this._addSource(source));
    }

    await Promise.all(todo);
  }

  private _removeSourceMapSources(compiled: ISourceWithMap, map: SourceMap, silent: boolean) {
    for (const url of map.sources) {
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

    const sourceMap = this._sourceMaps.get(source.sourceMap.url);
    if (
      !this.logger.assert(sourceMap, 'Unrecognized source map url in waitForSourceMapSources()')
    ) {
      return [];
    }

    await sourceMap.loaded;
    return [...source.sourceMap.sourceByUrl.values()];
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

type LineColumn = { lineNumber: number; columnNumber: number }; // 1-based

export function uiToRawOffset<T extends LineColumn>(lc: T, offset?: InlineScriptOffset): T {
  if (!offset) {
    return lc;
  }

  let { lineNumber, columnNumber } = lc;
  if (offset) {
    lineNumber += offset.lineOffset;
    if (lineNumber <= 1) columnNumber += offset.columnOffset;
  }

  return { ...lc, lineNumber, columnNumber };
}

export function rawToUiOffset<T extends LineColumn>(lc: T, offset?: InlineScriptOffset): T {
  if (!offset) {
    return lc;
  }

  let { lineNumber, columnNumber } = lc;
  if (offset) {
    lineNumber = Math.max(1, lineNumber - offset.lineOffset);
    if (lineNumber <= 1) columnNumber = Math.max(1, columnNumber - offset.columnOffset);
  }

  return { ...lc, lineNumber, columnNumber };
}

export const base0To1 = (lc: LineColumn) => ({
  lineNumber: lc.lineNumber + 1,
  columnNumber: lc.columnNumber + 1,
});

export const base1To0 = (lc: LineColumn) => ({
  lineNumber: lc.lineNumber - 1,
  columnNumber: lc.columnNumber - 1,
});
