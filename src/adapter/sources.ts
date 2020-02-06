/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as nls from 'vscode-nls';
import * as path from 'path';
import { URL } from 'url';
import { InlineScriptOffset, ISourcePathResolver } from '../common/sourcePathResolver';
import Dap from '../dap/api';
import * as sourceUtils from '../common/sourceUtils';
import { prettyPrintAsSourceMap } from '../common/sourceUtils';
import * as utils from '../common/urlUtils';
import { ScriptSkipper } from './scriptSkipper';
import { delay, getDeferred } from '../common/promiseUtil';
import { SourceMapConsumer, Position, NullablePosition } from 'source-map';
import { SourceMap } from '../common/sourceMaps/sourceMap';
import { ISourceMapRepository } from '../common/sourceMaps/sourceMapRepository';
import { MapUsingProjection } from '../common/datastructure/mapUsingProjection';
import { assert, logger } from '../common/logging/logger';
import { SourceMapFactory } from '../common/sourceMaps/sourceMapFactory';
import { LogTag } from '../common/logging';
import Cdp from '../cdp/api';
import { createHash } from 'crypto';

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

type ContentGetter = () => Promise<string | undefined>;

// Each source map has a number of compiled sources referncing it.
type SourceMapData = { compiled: Set<Source>; map?: SourceMap; loaded: Promise<void> };

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
  _sourceReference: number;
  _name: string;
  _fqname: string;
  _contentGetter: ContentGetter;
  _sourceMapUrl?: string;
  _inlineScriptOffset?: InlineScriptOffset;
  _container: SourceContainer;

  // Url has been mapped to some absolute path.
  _absolutePath: string;

  // This is the same as |_absolutePath|, but additionally checks that file exists to
  // avoid errors when page refers to non-existing paths/urls.
  _existingAbsolutePath: Promise<string | undefined>;

  // When compiled source references a source map, we'll generate source map sources.
  // This map |sourceUrl| as written in the source map itself to the Source.
  // Only present on compiled sources, exclusive with |_origin|.
  _sourceMapSourceByUrl?: Map<string, Source>;

  // Sources generated from the source map are referenced by some compiled sources
  // (through a source map). This map holds the original |sourceUrl| as written in the
  // source map, which was used to produce this source for each compiled.
  // Only present on source map sources, exclusive with |_sourceMapSourceByUrl|.
  _compiledToSourceUrl?: Map<Source, string>;

  private _content?: Promise<string | undefined>;

  private readonly _scriptIds: Cdp.Runtime.ScriptId[] = [];

  constructor(
    container: SourceContainer,
    public readonly url: string,
    absolutePath: string | undefined,
    contentGetter: ContentGetter,
    sourceMapUrl?: string,
    inlineScriptOffset?: InlineScriptOffset,
    contentHash?: string,
  ) {
    this._sourceReference = container.getSourceReference(url);
    this._contentGetter = contentGetter;
    this._sourceMapUrl = sourceMapUrl;
    this._inlineScriptOffset = inlineScriptOffset;
    this._container = container;
    this._fqname = this._fullyQualifiedName();
    this._name = path.basename(this._fqname);
    this._absolutePath = absolutePath || '';

    // Inline scripts will never match content of the html file. We skip the content check.
    if (inlineScriptOffset) contentHash = undefined;
    this._existingAbsolutePath = sourceUtils.checkContentHash(
      this._absolutePath,
      contentHash,
      container._fileContentOverridesForTest.get(this._absolutePath),
    );
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
    if (this._content === undefined) this._content = this._contentGetter();
    return this._content;
  }

  mimeType(): string {
    return 'text/javascript';
  }

  canPrettyPrint(): boolean {
    return this._container && !this._name.endsWith('-pretty.js');
  }

  async prettyPrint(): Promise<boolean> {
    if (!this._container || !this.canPrettyPrint()) return false;
    if (this._sourceMapUrl && this._sourceMapUrl.endsWith('-pretty.map')) return true;
    const content = await this.content();
    if (!content) return false;
    const sourceMapUrl = this.url + '-pretty.map';
    const fileName = this.url + '-pretty.js';
    const map = await prettyPrintAsSourceMap(fileName, content);
    if (!map) return false;
    // Note: this overwrites existing source map.
    this._sourceMapUrl = sourceMapUrl;
    const sourceMap: SourceMapData = { compiled: new Set([this]), map, loaded: Promise.resolve() };
    this._container._sourceMaps.set(sourceMapUrl, sourceMap);
    await this._container._addSourceMapSources(this, map);
    return true;
  }

  async toDap(): Promise<Dap.Source> {
    const existingAbsolutePath = await this._existingAbsolutePath;
    const sources = this._sourceMapSourceByUrl
      ? await Promise.all(Array.from(this._sourceMapSourceByUrl.values()).map(s => s.toDap()))
      : undefined;
    const dap: Dap.Source = {
      name: this._name,
      path: this._fqname,
      sourceReference: this._sourceReference,
      sources,
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
   * Returns a pretty name for the script. This is the name displayed in
   * stack traces and returned through DAP if the file does not verifiably
   * exist on disk.
   */
  _fullyQualifiedName(): string {
    if (!this.url) {
      return '<eval>/VM' + this._sourceReference;
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

    if (this._inlineScriptOffset) {
      fqname += `\uA789${this._inlineScriptOffset.lineOffset + 1}:${this._inlineScriptOffset
        .columnOffset + 1}`;
    }
    return fqname;
  }

  private blackboxed(): boolean {
    return this._container.isSourceSkipped(this.url);
  }
}

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

export class SourceContainer {
  private _dap: Dap.Api;
  private _sourceByReference: Map<number, Source> = new Map();
  private _sourceMapSourcesByUrl: Map<string, Source> = new Map();
  private _sourceByAbsolutePath: Map<string, Source> = new MapUsingProjection(
    utils.lowerCaseInsensitivePath,
  );

  // All source maps by url.
  _sourceMaps: Map<string, SourceMapData> = new Map();
  private _sourceMapTimeouts: SourceMapTimeouts = defaultTimeouts;

  // Test support.
  _fileContentOverridesForTest = new Map<string, string>();

  private _disabledSourceMaps = new Set<Source>();

  constructor(
    dap: Dap.Api,
    private readonly sourceMapFactory: SourceMapFactory,
    public readonly rootPath: string | undefined,
    public readonly sourcePathResolver: ISourcePathResolver,
    public readonly localSourceMaps: ISourceMapRepository,
    public readonly scriptSkipper: ScriptSkipper,
  ) {
    this._dap = dap;
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

  isSourceSkipped(url: string): boolean {
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
    let id = Math.abs(
      createHash('sha1')
        .update(url)
        .digest()
        .readInt32BE(0),
    );

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

    assert(false, 'Max iterations exceeding for source reference assignment');
    return id; // conflicts, but it's better than nothing, maybe?
  }

  // This method returns a "preferred" location. This usually means going through a source map
  // and showing the source map source instead of a compiled one. We use timeout to avoid
  // waiting for the source map for too long.
  async preferredUiLocation(uiLocation: IUiLocation): Promise<IPreferredUiLocation> {
    let isMapped = false;
    let unmappedReason: UnmappedReason | undefined = UnmappedReason.CannotMap;
    while (true) {
      const sourceMapUrl = uiLocation.source._sourceMapUrl;

      if (!sourceMapUrl) {
        break;
      }

      const sourceMap = this._sourceMaps.get(sourceMapUrl);
      if (!assert(sourceMap, `Expected to have sourcemap for loaded source ${sourceMapUrl}`)) {
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
    if (!uiLocation.source._sourceMapUrl) return [];
    const map = this._sourceMaps.get(uiLocation.source._sourceMapUrl)?.map;
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
    if (!compiled._sourceMapSourceByUrl) return UnmappedReason.CannotMap;

    const { lineNumber, columnNumber } = rawToUiOffset(uiLocation, compiled._inlineScriptOffset);
    const entry = map.originalPositionFor({ line: lineNumber, column: columnNumber });
    if (!entry.source) return UnmappedReason.CannotMap;

    const source = compiled._sourceMapSourceByUrl.get(entry.source);
    if (!source) return UnmappedReason.CannotMap;

    return {
      lineNumber: entry.line || 1,
      columnNumber: entry.column ? entry.column + 1 : 1, // adjust for 0-based columns
      source: source,
    };
  }

  private getCompiledLocations(uiLocation: IUiLocation): IUiLocation[] {
    if (!uiLocation.source._compiledToSourceUrl) {
      return [];
    }

    let output: IUiLocation[] = [];
    for (const [compiled, sourceUrl] of uiLocation.source._compiledToSourceUrl) {
      if (!assert(compiled._sourceMapUrl, 'Expected compiled script to have source map')) {
        continue;
      }

      const sourceMap = this._sourceMaps.get(compiled._sourceMapUrl);
      if (!sourceMap || !sourceMap.map) {
        continue;
      }

      const entry = this.getOptimalCompiledPosition(sourceUrl, uiLocation, sourceMap.map);
      if (!entry) {
        continue;
      }

      const { lineNumber, columnNumber } = uiToRawOffset(
        {
          lineNumber: entry.line || 1,
          columnNumber: (entry.column || 0) + 1, // correct for 0 index
        },
        compiled._inlineScriptOffset,
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
   * When calling `generatedPositionFor`, we may find non-exact matches. The
   * bias passed to the method controls which of the matches we choose.
   * Here, we will try to pick the position that maps back as closely as
   * possible to the source line if we get an approximate match,
   */
  private getOptimalCompiledPosition(
    sourceUrl: string,
    uiLocation: IUiLocation,
    sourceMap: SourceMapConsumer,
  ): NullablePosition | undefined {
    const prevLocation = sourceMap.generatedPositionFor({
      source: sourceUrl,
      line: uiLocation.lineNumber,
      column: uiLocation.columnNumber - 1, // source map columns are 0-indexed
      bias: SourceMapConsumer.GREATEST_LOWER_BOUND,
    });

    const getVariance = (position: NullablePosition) => {
      if (position.line === null || position.column === null) {
        return 10e10;
      }

      const original = sourceMap.originalPositionFor(position as Position);
      return original.line !== null ? Math.abs(uiLocation.lineNumber - original.line) : 10e10;
    };

    const nextVariance = getVariance(prevLocation);
    if (nextVariance === 0) {
      return prevLocation; // exact match, no need to work harder
    }

    const nextLocation = sourceMap.generatedPositionFor({
      source: sourceUrl,
      line: uiLocation.lineNumber,
      column: uiLocation.columnNumber - 1, // source map columns are 0-indexed
      bias: SourceMapConsumer.LEAST_UPPER_BOUND,
    });

    return getVariance(nextLocation) < nextVariance ? nextLocation : prevLocation;
  }

  async addSource(
    url: string,
    contentGetter: ContentGetter,
    sourceMapUrl?: string,
    inlineSourceRange?: InlineScriptOffset,
    contentHash?: string,
  ): Promise<Source> {
    const absolutePath = await this.sourcePathResolver.urlToAbsolutePath({ url });
    logger.verbose(LogTag.RuntimeSourceCreate, 'Creating source from url', {
      inputUrl: url,
      absolutePath,
    });

    const source = new Source(
      this,
      url,
      absolutePath,
      contentGetter,
      sourceMapUrl,
      inlineSourceRange,
      contentHash,
    );
    this._addSource(source);
    return source;
  }

  async _addSource(source: Source) {
    this._sourceByReference.set(source.sourceReference(), source);
    if (source._compiledToSourceUrl) {
      this._sourceMapSourcesByUrl.set(source.url, source);
    }

    // Some builds, like the Vue starter, generate 'metadata' files for compiled
    // files with query strings appended to deduplicate them, or nested inside
    // of internal prefixes. If we see a duplicate entries for an absolute path,
    // take the shorter of them.
    const existingByPath = this._sourceByAbsolutePath.get(source._absolutePath);
    if (existingByPath === undefined || existingByPath.url.length >= source.url.length) {
      this._sourceByAbsolutePath.set(source._absolutePath, source);
    }

    source.toDap().then(dap => this._dap.loadedSource({ reason: 'new', source: dap }));

    const sourceMapUrl = source._sourceMapUrl;
    if (!sourceMapUrl) {
      return;
    }

    const mapMetadata = {
      sourceMapUrl,
      compiledPath: source.absolutePath() || source.url,
    };

    if (!this.sourcePathResolver.shouldResolveSourceMap(mapMetadata)) {
      source._sourceMapUrl = undefined;
      return;
    }

    const existingSourceMap = this._sourceMaps.get(sourceMapUrl);
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
    this._sourceMaps.set(sourceMapUrl, sourceMap);

    // will log any errors internally:
    const loaded = await this.sourceMapFactory.load(mapMetadata);
    if (loaded) {
      sourceMap.map = loaded;
    } else {
      return deferred.resolve();
    }

    // Source map could have been detached while loading.
    if (this._sourceMaps.get(sourceMapUrl) !== sourceMap) return deferred.resolve();

    await Promise.all([...sourceMap.compiled].map(c => this._addSourceMapSources(c, loaded)));
    deferred.resolve();
  }

  removeSource(source: Source, silent = false) {
    const existing = this._sourceByReference.get(source.sourceReference());
    if (existing === undefined) {
      return; // already removed
    }

    assert(source === existing, 'Expected source to be the same as the existing reference');
    this._sourceByReference.delete(source.sourceReference());
    if (source._compiledToSourceUrl) this._sourceMapSourcesByUrl.delete(source.url);
    this._sourceByAbsolutePath.delete(source._absolutePath);
    this._disabledSourceMaps.delete(source);
    if (!silent) {
      source.toDap().then(dap => this._dap.loadedSource({ reason: 'removed', source: dap }));
    }

    const sourceMapUrl = source._sourceMapUrl;
    if (!sourceMapUrl) return;

    const sourceMap = this._sourceMaps.get(sourceMapUrl);
    if (!assert(sourceMap, `Source map missing for ${sourceMapUrl} in removeSource()`)) {
      return;
    }
    assert(
      sourceMap.compiled.has(source),
      `Source map ${sourceMapUrl} does not contain source ${source.url}`,
    );

    sourceMap.compiled.delete(source);
    if (!sourceMap.compiled.size) {
      if (sourceMap.map) sourceMap.map.destroy();
      this._sourceMaps.delete(sourceMapUrl);
    }
    // Source map could still be loading, or failed to load.
    if (sourceMap.map) {
      this._removeSourceMapSources(source, sourceMap.map, silent);
    }
  }

  async _addSourceMapSources(compiled: Source, map: SourceMap) {
    compiled._sourceMapSourceByUrl = new Map();
    const todo: Promise<void>[] = [];
    for (const url of map.sources) {
      const absolutePath = await this.sourcePathResolver.urlToAbsolutePath({ url, map });
      const resolvedUrl =
        (absolutePath && utils.absolutePathToFileUrl(absolutePath)) || map.computedSourceUrl(url);

      let source = this._sourceMapSourcesByUrl.get(resolvedUrl);
      if (source) {
        source._compiledToSourceUrl!.set(compiled, url);
        compiled._sourceMapSourceByUrl.set(url, source);
        return;
      }

      logger.verbose(LogTag.RuntimeSourceCreate, 'Creating source from source map', {
        inputUrl: url,
        inputMap: map.metadata,
        absolutePath,
        resolvedUrl,
        sourceMapSources: map.sources,
      });

      // Note: we can support recursive source maps here if we parse sourceMapUrl comment.
      const fileUrl = absolutePath && utils.absolutePathToFileUrl(absolutePath);
      const content = map.sourceContentFor(url) ?? undefined;

      source = new Source(
        this,
        resolvedUrl,
        absolutePath,
        content !== undefined
          ? () => Promise.resolve(content)
          : fileUrl
          ? () => utils.fetch(fileUrl)
          : compiled._contentGetter,
        undefined,
        undefined,
        undefined,
      );
      source._compiledToSourceUrl = new Map();
      source._compiledToSourceUrl.set(compiled, url);
      compiled._sourceMapSourceByUrl.set(url, source);
      todo.push(this._addSource(source));
    }

    await Promise.all(todo);
  }

  private _removeSourceMapSources(compiled: Source, map: SourceMap, silent: boolean) {
    if (!compiled._sourceMapSourceByUrl) {
      return;
    }

    for (const url of map.sources) {
      const source = compiled._sourceMapSourceByUrl.get(url);
      if (!assert(source, `Unknown source ${url} in removeSourceMapSources`)) {
        continue;
      }

      if (
        !assert(
          source._compiledToSourceUrl,
          `Compiled source ${url} missing map in removeSourceMapSources`,
        )
      ) {
        continue;
      }

      compiled._sourceMapSourceByUrl.delete(url);
      if (
        !assert(
          source?._compiledToSourceUrl,
          `Source ${url} is missing compiled file ${compiled.url}`,
        )
      ) {
        continue;
      }

      source._compiledToSourceUrl.delete(compiled);
      if (source._compiledToSourceUrl.size) continue;
      this.removeSource(source, silent);
    }
  }

  // Waits for source map to be loaded (if any), and sources to be created from it.
  public async waitForSourceMapSources(source: Source): Promise<Source[]> {
    if (!source._sourceMapUrl) return [];
    const sourceMap = this._sourceMaps.get(source._sourceMapUrl);
    if (!assert(sourceMap, 'Unrecognized source mpa url in waitForSourceMapSources()')) {
      return [];
    }

    await sourceMap.loaded;
    if (!source._sourceMapSourceByUrl) return [];
    return Array.from(source._sourceMapSourceByUrl.values());
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

  clearDisabledSourceMaps() {
    this._disabledSourceMaps.clear();
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
