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
import { SourceMapConsumer } from 'source-map';
import { SourceMap } from '../common/sourceMaps/sourceMap';
import { ISourceMapRepository } from '../common/sourceMaps/sourceMapRepository';
import { MapUsingProjection } from '../common/datastructure/mapUsingProjection';
import { assert, logger } from '../common/logging/logger';
import { SourceMapCache } from './sourceMapCache';
import { LogTag } from '../common/logging';

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
  private static _lastSourceReference = 0;
  _sourceReference: number;
  _url: string;
  _name: string;
  _blackboxed = false;
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

  constructor(
    container: SourceContainer,
    url: string,
    absolutePath: string | undefined,
    contentGetter: ContentGetter,
    sourceMapUrl?: string,
    inlineScriptOffset?: InlineScriptOffset,
    contentHash?: string,
  ) {
    this._sourceReference = ++Source._lastSourceReference;
    this._url = url;
    this._contentGetter = contentGetter;
    this._sourceMapUrl = sourceMapUrl;
    this._inlineScriptOffset = inlineScriptOffset;
    this._container = container;
    this._fqname = this._fullyQualifiedName();
    this._name = path.basename(this._fqname);
    this._absolutePath = absolutePath || '';

    if (container.scriptSkipper) {
      container.scriptSkipper.updateSkippingForScript(this._absolutePath, url);
      this._blackboxed = container.scriptSkipper.isScriptSkipped(url);
    }

    // Inline scripts will never match content of the html file. We skip the content check.
    if (inlineScriptOffset) contentHash = undefined;
    this._existingAbsolutePath = sourceUtils.checkContentHash(
      this._absolutePath,
      contentHash,
      container._fileContentOverridesForTest.get(this._absolutePath),
    );
  }

  url(): string {
    return this._url;
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
    const sourceMapUrl = this.url() + '-pretty.map';
    const fileName = this.url() + '-pretty.js';
    const map = await prettyPrintAsSourceMap(fileName, content);
    if (!map) return false;
    // Note: this overwrites existing source map.
    this._sourceMapUrl = sourceMapUrl;
    const sourceMap: SourceMapData = { compiled: new Set([this]), map, loaded: Promise.resolve() };
    this._container._sourceMaps.set(sourceMapUrl, sourceMap);
    await this._container._addSourceMapSources(this, map, sourceMapUrl);
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
      presentationHint: this._blackboxed ? 'deemphasize' : undefined,
      origin: this._blackboxed ? localize('source.isBlackboxed', 'blackboxed') : undefined,
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

  _fullyQualifiedName(): string {
    if (!this._url) return '<eval>/VM' + this._sourceReference;
    let fqname = this._url;
    try {
      const tokens: string[] = [];
      const url = new URL(this._url);
      if (url.protocol === 'data:') return '<eval>/VM' + this._sourceReference;
      if (url.hostname) tokens.push(url.hostname);
      if (url.port) tokens.push('\uA789' + url.port); // : in unicode
      if (url.pathname) tokens.push(url.pathname);
      if (url.searchParams) tokens.push(url.searchParams.toString());
      fqname = tokens.join('');
    } catch (e) {}
    if (fqname.endsWith('/')) fqname += '(index)';
    if (this._inlineScriptOffset)
      fqname = `${fqname}\uA789${this._inlineScriptOffset.lineOffset + 1}:${this._inlineScriptOffset
        .columnOffset + 1}`;
    return fqname;
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
  private _scriptSkipper?: ScriptSkipper;

  constructor(
    dap: Dap.Api,
    private readonly sourceMapCache: SourceMapCache,
    public readonly rootPath: string | undefined,
    public readonly sourcePathResolver: ISourcePathResolver,
    public readonly localSourceMaps: ISourceMapRepository,
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

  initializeScriptSkipper(scriptSkipper: ScriptSkipper) {
    this._scriptSkipper = scriptSkipper;
  }

  get scriptSkipper(): ScriptSkipper | undefined {
    return this._scriptSkipper;
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
      columnNumber: entry.column || 1,
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

      const entry = sourceMap.map.generatedPositionFor({
        source: sourceUrl,
        line: uiLocation.lineNumber,
        column: uiLocation.columnNumber - 1, // source map columns are 0-indexed
        bias: SourceMapConsumer.LEAST_UPPER_BOUND,
      });

      if (entry.line === null) {
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
    if (source._compiledToSourceUrl) this._sourceMapSourcesByUrl.set(source._url, source);
    this._sourceByAbsolutePath.set(source._absolutePath, source);
    source.toDap().then(dap => this._dap.loadedSource({ reason: 'new', source: dap }));

    const sourceMapUrl = source._sourceMapUrl;
    if (!sourceMapUrl) return;

    const existingSourceMap = this._sourceMaps.get(sourceMapUrl);
    if (existingSourceMap) {
      existingSourceMap.compiled.add(source);
      if (existingSourceMap.map) {
        // If source map has been already loaded, we add sources here.
        // Otheriwse, we'll add sources for all compiled after loading the map.
        await this._addSourceMapSources(source, existingSourceMap.map, sourceMapUrl);
      }
      return;
    }

    const deferred = getDeferred<void>();
    const sourceMap: SourceMapData = { compiled: new Set([source]), loaded: deferred.promise };
    this._sourceMaps.set(sourceMapUrl, sourceMap);

    // will log any errors internally:
    const loaded = await this.sourceMapCache.load({
      sourceMapUrl,
      compiledPath: source.absolutePath(),
    });
    if (loaded) {
      sourceMap.map = loaded;
    } else {
      return deferred.resolve();
    }

    // Source map could have been detached while loading.
    if (this._sourceMaps.get(sourceMapUrl) !== sourceMap) return deferred.resolve();

    await Promise.all(
      [...sourceMap.compiled].map(c => this._addSourceMapSources(c, loaded, sourceMapUrl)),
    );
    deferred.resolve();
  }

  removeSource(source: Source) {
    console.assert(this._sourceByReference.get(source.sourceReference()) === source);
    this._sourceByReference.delete(source.sourceReference());
    if (source._compiledToSourceUrl) this._sourceMapSourcesByUrl.delete(source._url);
    this._sourceByAbsolutePath.delete(source._absolutePath);
    this._disabledSourceMaps.delete(source);
    source.toDap().then(dap => this._dap.loadedSource({ reason: 'removed', source: dap }));

    const sourceMapUrl = source._sourceMapUrl;
    if (!sourceMapUrl) return;

    const sourceMap = this._sourceMaps.get(sourceMapUrl);
    if (!assert(sourceMap, `Source map missing for ${sourceMapUrl} in removeSource()`)) {
      return;
    }
    assert(
      sourceMap.compiled.has(source),
      `Source map ${sourceMapUrl} does not contain source ${source.url()}`,
    );

    sourceMap.compiled.delete(source);
    if (!sourceMap.compiled.size) {
      if (sourceMap.map) sourceMap.map.destroy();
      this._sourceMaps.delete(sourceMapUrl);
    }
    // Source map could still be loading, or failed to load.
    if (sourceMap.map) this._removeSourceMapSources(source, sourceMap.map);
  }

  async _addSourceMapSources(compiled: Source, map: SourceMap, sourceMapUrl: string) {
    compiled._sourceMapSourceByUrl = new Map();
    if (!this.sourcePathResolver.shouldResolveSourceMap(map)) {
      return;
    }

    const todo: Promise<void>[] = [];
    for (const url of map.sources) {
      // Per source map spec, |sourceUrl| is relative to the source map's own url. However,
      // webpack emits absolute paths in some situations instead of a relative url. We check
      // whether |sourceUrl| looks like a path and belongs to the workspace.
      const sourceUrl = utils.maybeAbsolutePathToFileUrl(this.rootPath, url);
      const baseUrl = sourceMapUrl.startsWith('data:') ? compiled.url() : sourceMapUrl;
      const resolvedUrl = utils.completeUrlEscapingRoot(baseUrl, sourceUrl);
      const contentOrNull = map.sourceContentFor(url);
      const content = contentOrNull === null ? undefined : contentOrNull;
      let source = this._sourceMapSourcesByUrl.get(resolvedUrl);
      const isNew = !source;
      if (!source) {
        const absolutePath = await this.sourcePathResolver.urlToAbsolutePath({ url: resolvedUrl, map });
        logger.verbose(LogTag.RuntimeSourceCreate, 'Creating source from source map', {
          inputUrl: resolvedUrl,
          absolutePath,
          compiledUrl: compiled.url(),
          sourceMapSources: map.sources,
        });

        // Note: we can support recursive source maps here if we parse sourceMapUrl comment.
        source = new Source(
          this,
          resolvedUrl,
          absolutePath,
          content !== undefined ? () => Promise.resolve(content) : () => utils.fetch(resolvedUrl),
          undefined,
          undefined,
          undefined,
        );
        source._compiledToSourceUrl = new Map();
      }
      // eslint-disable-next-line
      source._compiledToSourceUrl!.set(compiled, url);
      compiled._sourceMapSourceByUrl.set(url, source);
      if (isNew) todo.push(this._addSource(source));
    }

    await Promise.all(todo);
  }

  _removeSourceMapSources(compiled: Source, map: SourceMap) {
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
          `Source ${url} is missing compiled file ${compiled._url}`,
        )
      ) {
        continue;
      }

      source._compiledToSourceUrl.delete(compiled);
      if (source._compiledToSourceUrl.size) continue;
      this.removeSource(source);
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
