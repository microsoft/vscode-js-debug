/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as nls from 'vscode-nls';
import { URL } from 'url';
import { InlineScriptOffset, ISourcePathResolver } from '../common/sourcePathResolver';
import Dap from '../dap/api';
import * as sourceUtils from '../common/sourceUtils';
import { prettyPrintAsSourceMap } from '../common/sourceUtils';
import * as utils from '../common/urlUtils';
import { ScriptSkipper } from './scriptSkipper/implementation';
import { delay, getDeferred } from '../common/promiseUtil';
import { SourceMapConsumer, NullableMappedPosition } from 'source-map';
import { SourceMap, ISourceMapMetadata } from '../common/sourceMaps/sourceMap';
import { MapUsingProjection } from '../common/datastructure/mapUsingProjection';
import { ISourceMapFactory } from '../common/sourceMaps/sourceMapFactory';
import { LogTag, ILogger } from '../common/logging';
import Cdp from '../cdp/api';
import { createHash } from 'crypto';
import { isSubdirectoryOf, forceForwardSlashes } from '../common/pathUtils';
import { relative } from 'path';
import { inject, injectable } from 'inversify';
import { IDapApi } from '../dap/connection';
import { AnyLaunchConfiguration } from '../configuration';
import { Script } from './threads';
import { IScriptSkipper } from './scriptSkipper/scriptSkipper';
import { once } from '../common/objUtils';
import { IResourceProvider } from './resourceProvider';
import { sourceMapParseFailed } from '../dap/errors';

const localize = nls.loadMessageBundle();

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

const getNullPosition = () => ({
  source: null,
  line: null,
  column: null,
  name: null,
  lastColumn: null,
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

  // When pausing before script with source map, we wait no longer than |scriptPaused| timeout
  // for source map to be loaded and breakpoints to be set. This usually ensures that breakpoints
  // won't be missed.
  scriptPaused: number;

  // When sending multiple entities to debug console, we wait for each one to be asynchronously
  // processed. If one of them stalls, we resume processing others after |output| timeout.
  output: number;
};

const defaultTimeouts: SourceMapTimeouts = {
  load: 0,
  resolveLocation: 2000,
  scriptPaused: 1000,
  output: 1000,
};

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
  private readonly _sourceReference: number;
  private readonly _name: string;
  private readonly _fqname: string;

  /**
   * Function to retrieve the content of the source.
   */
  private readonly _contentGetter: ContentGetter;

  private readonly _container: SourceContainer;

  // Url has been mapped to some absolute path.
  private readonly _absolutePath: string;

  public sourceMap?: ISourceWithMap['sourceMap'];

  // This is the same as |_absolutePath|, but additionally checks that file exists to
  // avoid errors when page refers to non-existing paths/urls.
  private readonly _existingAbsolutePath: Promise<string | undefined>;
  private readonly _scriptIds: Cdp.Runtime.ScriptId[] = [];

  /**
   * @param inlineScriptOffset Offset of the start location of the script in
   * its source file. This is used on scripts in HTML pages, where the script
   * is nested in the content.
   * @param contentHash Optional hash of the file contents. This is used to
   * check whether the script we get is the same one as what's on disk. This
   * can be used to detect in-place transpilation.
   */
  constructor(
    container: SourceContainer,
    public readonly url: string,
    absolutePath: string | undefined,
    contentGetter: ContentGetter,
    sourceMapUrl?: string,
    public readonly inlineScriptOffset?: InlineScriptOffset,
    contentHash?: string,
  ) {
    this._sourceReference = container.getSourceReference(url);
    this._contentGetter = once(contentGetter);
    this._container = container;
    this._absolutePath = absolutePath || '';
    this._fqname = this._fullyQualifiedName();
    this._name = this._humanName();
    this.setSourceMapUrl(sourceMapUrl);

    this._existingAbsolutePath = sourceUtils.checkContentHash(
      this._absolutePath,
      // Inline scripts will never match content of the html file. We skip the content check.
      inlineScriptOffset ? undefined : contentHash,
      container._fileContentOverridesForTest.get(this._absolutePath),
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
        compiledPath: this._absolutePath || this.url,
      },
    };
  }

  addScriptId(scriptId: Cdp.Runtime.ScriptId): void {
    this._scriptIds.push(scriptId);
  }

  scriptIds(): Cdp.Runtime.ScriptId[] {
    return this._scriptIds;
  }

  sourceReference(): number {
    return this._sourceReference;
  }

  content(): Promise<string | undefined> {
    return this._contentGetter();
  }

  mimeType(): string {
    return 'text/javascript';
  }

  /**
   * Gets whether this source is able to be pretty-printed.
   */
  public canPrettyPrint(): boolean {
    return this._container && !this._name.endsWith('-pretty.js');
  }

  /**
   * Pretty-prints the source. Generates a beauitified source map if possible
   * and it hasn't already been done, and returns the created map and created
   * ephemeral source. Returns undefined if the source can't be beautified.
   */
  public async prettyPrint(): Promise<{ map: SourceMap; source: Source } | undefined> {
    if (!this._container || !this.canPrettyPrint()) {
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

    const sourceMapUrl = this.url + '-pretty.map';
    const basename = this.url.split(/[\/\\]/).pop() as string;
    const fileName = basename + '-pretty.js';
    const map = await prettyPrintAsSourceMap(fileName, content, this.url, sourceMapUrl);
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
      sourceReference: this._sourceReference,
      presentationHint: this.blackboxed() ? 'deemphasize' : undefined,
      origin: this.blackboxed() ? localize('source.skipFiles', 'Skipped by skipFiles') : undefined,
    };

    if (existingAbsolutePath) {
      dap.sourceReference = 0;
      dap.path = existingAbsolutePath;
    }

    return dap;
  }

  absolutePath(): string {
    return this._absolutePath;
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
      const root = this._container.rootPath;
      if (root && isSubdirectoryOf(root, this._fqname)) {
        return forceForwardSlashes(relative(root, this._fqname));
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
      return '<eval>/VM' + this._sourceReference;
    }

    if (this._absolutePath.startsWith('<node_internals>')) {
      return this._absolutePath;
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
        return '<eval>/VM' + this._sourceReference;
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

      if (url.searchParams) {
        tokens.push(url.searchParams.toString());
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

  private blackboxed(): boolean {
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
  source instanceof Source && !!source.sourceMap;

export interface IPreferredUiLocation extends IUiLocation {
  isMapped: boolean;
  unmappedReason?: UnmappedReason;
}

export enum UnmappedReason {
  /** The map has been disabled temporarily, due to setting a breakpoint in a compiled script */
  MapDisabled,

  /**
   * The location cannot be sourcemapped, due to not having a sourcemap,
   * failing to load the sourcemap, not having a mapping in the sourcemap, etc
   */
  CannotMap,
}

@injectable()
export class SourceContainer {
  /**
   * Project root path, if set.
   */
  public readonly rootPath?: string;

  /**
   * Mapping of CDP script IDs to Script objects.
   */
  public scriptsById: Map<Cdp.Runtime.ScriptId, Script> = new Map();

  private _dap: Dap.Api;
  private _sourceByReference: Map<number, Source> = new Map();
  private _sourceMapSourcesByUrl: Map<string, SourceFromMap> = new Map();
  private _sourceByAbsolutePath: Map<string, Source> = new MapUsingProjection(
    utils.lowerCaseInsensitivePath,
  );

  // All source maps by url.
  _sourceMaps: Map<string, SourceMapData> = new Map();
  private _sourceMapTimeouts: SourceMapTimeouts = defaultTimeouts;

  // Test support.
  _fileContentOverridesForTest = new Map<string, string>();

  private _disabledSourceMaps = new Set<Source>();

  /**
   * A set of sourcemaps that we warned about failing to parse.
   * @see SourceContainer#guardSourceMapFn
   */
  private hasWarnedAboutMaps = new Set<SourceMap>();

  constructor(
    @inject(IDapApi) dap: Dap.Api,
    @inject(ISourceMapFactory) private readonly sourceMapFactory: ISourceMapFactory,
    @inject(ILogger) private readonly logger: ILogger,
    @inject(AnyLaunchConfiguration) launchConfig: AnyLaunchConfiguration,
    @inject(ISourcePathResolver) public readonly sourcePathResolver: ISourcePathResolver,
    @inject(IScriptSkipper) public readonly scriptSkipper: ScriptSkipper,
    @inject(IResourceProvider) private readonly resourceProvider: IResourceProvider,
  ) {
    this._dap = dap;
    this.rootPath = 'webRoot' in launchConfig ? launchConfig.webRoot : launchConfig.rootPath;
    scriptSkipper.setSourceContainer(this);
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

  async loadedSources(): Promise<Dap.Source[]> {
    const promises: Promise<Dap.Source>[] = [];
    for (const source of this._sourceByReference.values()) promises.push(source.toDap());
    return await Promise.all(promises);
  }

  source(ref: Dap.Source): Source | undefined {
    if (ref.sourceReference) return this._sourceByReference.get(ref.sourceReference);
    if (ref.path) return this._sourceByAbsolutePath.get(ref.path);
    return undefined;
  }

  public isSourceSkipped(url: string): boolean {
    return this.scriptSkipper.isScriptSkipped(url);
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
    let id = Math.abs(createHash('sha1').update(url).digest().readInt32BE(0));

    for (let i = 0; i < 0xffff; i++) {
      if (!this._sourceByReference.has(id)) {
        return id;
      }

      if (id === 2 ** 31 - 1) {
        // DAP spec says max reference ID is 2^31 - 1, int32
        id = 0;
      }

      id++;
    }

    this.logger.assert(false, 'Max iterations exceeding for source reference assignment');
    return id; // conflicts, but it's better than nothing, maybe?
  }

  // This method returns a "preferred" location. This usually means going through a source map
  // and showing the source map source instead of a compiled one. We use timeout to avoid
  // waiting for the source map for too long.
  async preferredUiLocation(uiLocation: IUiLocation): Promise<IPreferredUiLocation> {
    let isMapped = false;
    let unmappedReason: UnmappedReason | undefined = UnmappedReason.CannotMap;
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
    if (!isSourceWithMap(uiLocation.source)) return [];
    const map = this._sourceMaps.get(uiLocation.source.sourceMap.url)?.map;
    if (!map) return [];
    const sourceMapUiLocation = this._sourceMappedUiLocation(uiLocation, map);
    if (!isUiLocation(sourceMapUiLocation)) return [];

    const r = this.getSourceMapUiLocations(sourceMapUiLocation);
    r.push(sourceMapUiLocation);
    return r;
  }

  _sourceMappedUiLocation(uiLocation: IUiLocation, map: SourceMap): IUiLocation | UnmappedReason {
    const compiled = uiLocation.source;
    if (this._disabledSourceMaps.has(compiled)) return UnmappedReason.MapDisabled;
    if (!isSourceWithMap(compiled)) return UnmappedReason.CannotMap;

    const entry = this.getOptiminalOriginalPosition(
      map,
      rawToUiOffset(uiLocation, compiled.inlineScriptOffset),
    );
    if (!entry.source) return UnmappedReason.CannotMap;

    const source = compiled.sourceMap.sourceByUrl.get(entry.source);
    if (!source) return UnmappedReason.CannotMap;

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

      const entry = this.guardSourceMapFn(
        sourceMap.map,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        () => sourceUtils.getOptimalCompiledPosition(sourceUrl, uiLocation, sourceMap.map!),
        getNullPosition,
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
    return this.guardSourceMapFn<NullableMappedPosition>(
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
      getNullPosition,
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
      contentHash,
    );
    this._addSource(source);
    return source;
  }

  private async _addSource(source: Source) {
    this._sourceByReference.set(source.sourceReference(), source);
    if (source instanceof SourceFromMap) {
      this._sourceMapSourcesByUrl.set(source.url, source);
    }

    // Some builds, like the Vue starter, generate 'metadata' files for compiled
    // files with query strings appended to deduplicate them, or nested inside
    // of internal prefixes. If we see a duplicate entries for an absolute path,
    // take the shorter of them.
    const existingByPath = this._sourceByAbsolutePath.get(source.absolutePath());
    if (
      existingByPath === undefined ||
      existingByPath.url.length >= source.url.length ||
      (source instanceof SourceFromMap &&
        source.compiledToSourceUrl.has(existingByPath as ISourceWithMap))
    ) {
      this._sourceByAbsolutePath.set(source.absolutePath(), source);
    }

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
    } catch (e) {
      this._dap.output({
        output: sourceMapParseFailed(source.url, e.message).error.format,
        category: 'stderr',
      });

      return deferred.resolve();
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
    deferred.resolve();
  }

  removeSource(source: Source, silent = false) {
    const existing = this._sourceByReference.get(source.sourceReference());
    if (existing === undefined) {
      return; // already removed
    }

    this.logger.assert(
      source === existing,
      'Expected source to be the same as the existing reference',
    );
    this._sourceByReference.delete(source.sourceReference());
    if (source instanceof SourceFromMap) {
      this._sourceMapSourcesByUrl.delete(source.url);
    }

    this._sourceByAbsolutePath.delete(source.absolutePath());
    this._disabledSourceMaps.delete(source);
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
    const todo: Promise<void>[] = [];
    for (const url of map.sources) {
      const absolutePath = await this.sourcePathResolver.urlToAbsolutePath({ url, map });
      const resolvedUrl = absolutePath
        ? utils.absolutePathToFileUrl(absolutePath)
        : map.computedSourceUrl(url);

      const existing = this._sourceMapSourcesByUrl.get(resolvedUrl);
      if (existing) {
        existing.compiledToSourceUrl.set(compiled, url);
        compiled.sourceMap.sourceByUrl.set(url, existing);
        continue;
      }

      this.logger.verbose(LogTag.RuntimeSourceCreate, 'Creating source from source map', {
        inputUrl: url,
        sourceMapId: map.id,
        absolutePath,
        resolvedUrl,
      });

      // Note: we can support recursive source maps here if we parse sourceMapUrl comment.
      const fileUrl = absolutePath && utils.absolutePathToFileUrl(absolutePath);
      const content = this.guardSourceMapFn(
        map,
        () => map.sourceContentFor(url),
        () => null,
      );

      const source = new SourceFromMap(
        this,
        resolvedUrl,
        absolutePath,
        content !== null
          ? () => Promise.resolve(content)
          : fileUrl
          ? () => this.resourceProvider.fetch(fileUrl)
          : () => compiled.content(),
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
      if (!this.logger.assert(source, `Unknown source ${url} in removeSourceMapSources`)) {
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
      !this.logger.assert(sourceMap, 'Unrecognized source mpa url in waitForSourceMapSources()')
    ) {
      return [];
    }

    await sourceMap.loaded;
    return [...source.sourceMap.sourceByUrl.values()];
  }

  /**
   * Guards a call to a source map invokation to catch parse errors. Sourcemap
   * parsing happens lazily, so we need to wrap around their call sites.
   * @see https://github.com/microsoft/vscode-js-debug/issues/483
   */
  private guardSourceMapFn<T>(sourceMap: SourceMap, fn: () => T, defaultValue: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (!/error parsing/i.test(String(e.message))) {
        throw e;
      }

      if (!this.hasWarnedAboutMaps.has(sourceMap)) {
        this._dap.output({
          output: sourceMapParseFailed(sourceMap.metadata.compiledPath, e.message).error.format,
          category: 'stderr',
        });
        this.hasWarnedAboutMaps.add(sourceMap);
      }

      return defaultValue();
    }
  }

  async revealUiLocation(uiLocation: IUiLocation) {
    this._dap.revealLocationRequested({
      source: await uiLocation.source.toDap(),
      line: uiLocation.lineNumber,
      column: uiLocation.columnNumber,
    });
  }

  disableSourceMapForSource(source: Source) {
    this._disabledSourceMaps.add(source);
  }

  clearDisabledSourceMaps(forSource?: Source) {
    if (forSource) {
      this._disabledSourceMaps.delete(forSource);
    } else {
      this._disabledSourceMaps.clear();
    }
  }
}

type LineColumn = { lineNumber: number; columnNumber: number }; // 1-based

export function uiToRawOffset(lc: LineColumn, offset?: InlineScriptOffset): LineColumn {
  let { lineNumber, columnNumber } = lc;
  if (offset) {
    lineNumber += offset.lineOffset;
    if (lineNumber <= 1) columnNumber += offset.columnOffset;
  }
  return { lineNumber, columnNumber };
}

export function rawToUiOffset(lc: LineColumn, offset?: InlineScriptOffset): LineColumn {
  let { lineNumber, columnNumber } = lc;
  if (offset) {
    lineNumber = Math.max(1, lineNumber - offset.lineOffset);
    if (lineNumber <= 1) columnNumber = Math.max(1, columnNumber - offset.columnOffset);
  }
  return { lineNumber, columnNumber };
}

export const base0To1 = (lc: LineColumn) => ({
  lineNumber: lc.lineNumber + 1,
  columnNumber: lc.columnNumber + 1,
});

export const base1To0 = (lc: LineColumn) => ({
  lineNumber: lc.lineNumber - 1,
  columnNumber: lc.columnNumber - 1,
});
