/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as sourcemap from 'source-map';
import * as utils from '../utils/urlUtils';
import * as fs from 'fs';
import Dap from '../dap/api';
import { URL } from 'url';
import * as path from 'path';
import * as errors from './errors';
import { prettyPrintAsSourceMap } from './prettyPrint';

// This is a ui location. Usually it corresponds to a position
// in the document user can see (Source, Dap.Source). When no source
// is available, it just holds a url to show in the ui.
export interface Location {
  lineNumber: number; // 1-based
  columnNumber: number;  // 1-based
  url: string;
  source?: Source;
};

type ContentGetter = () => Promise<string | undefined>;
export type InlineScriptOffset = { lineOffset: number, columnOffset: number };
type SourceMapConsumer = sourcemap.BasicSourceMapConsumer | sourcemap.IndexedSourceMapConsumer;
type SourceMapData = { compiled: Set<Source>, map?: SourceMapConsumer, loaded: Promise<void> };

export type SourceMapTimeouts = {
  load: number;
  resolveLocation: number;
  scriptPaused: number;
  output: number;
};

const defaultTimeouts: SourceMapTimeouts = {
  load: 0,
  resolveLocation: 2000,
  scriptPaused: 1000,
  output: 1000,
};

export interface LocationRevealer {
  revealLocation(location: Location): Promise<void>;
}

export interface SourcePathResolver {
  rewriteSourceUrl(sourceUrl: string): string;
  urlToAbsolutePath(url: string): string;
  absolutePathToUrl(absolutePath: string): string | undefined;
  scriptUrlToUrl(url: string): string;
}

export class Source {
  private static _lastSourceReference = 0;

  _sourceReference: number;
  _url: string;
  _name: string;
  _fqname: string;
  _contentGetter: ContentGetter;
  _sourceMapUrl?: string;
  _inlineScriptOffset?: InlineScriptOffset;
  _container: SourceContainer;
  _absolutePath: string;
  _existingAbsolutePath: Promise<string | undefined>;

  // Sources generated for this compiled from it's source map. Exclusive with |_origin|.
  _sourceMapSourceByUrl?: Map<string, Source>;
  // SourceUrl (as listed in source map) for each compiled referencing this source.
  // Exclusive with |_sourceMapSourceByUrl|.
  _compiledToSourceUrl?: Map<Source, string>;

  private _content?: Promise<string | undefined>;

  constructor(container: SourceContainer, url: string, contentGetter: ContentGetter, sourceMapUrl?: string, inlineScriptOffset?: InlineScriptOffset) {
    this._sourceReference = ++Source._lastSourceReference;
    this._url = url;
    this._contentGetter = contentGetter;
    this._sourceMapUrl = sourceMapUrl;
    this._inlineScriptOffset = inlineScriptOffset;
    this._container = container;
    this._fqname = this._fullyQualifiedName();
    this._name = path.basename(this._fqname);
    this._absolutePath = container._sourcePathResolver.urlToAbsolutePath(url);
    this._existingAbsolutePath = checkExists(this._absolutePath);
  }

  url(): string {
    return this._url;
  }

  sourceReference(): number {
    return this._sourceReference;
  }

  content(): Promise<string | undefined> {
    if (this._content === undefined)
      this._content = this._contentGetter();
    return this._content;
  }

  mimeType(): string {
    return 'text/javascript';
  }

  canPrettyPrint(): boolean {
    return this._container && !this._name.endsWith('-pretty.js');
  }

  async prettyPrint(): Promise<boolean> {
    if (!this._container || !this.canPrettyPrint())
      return false;
    if (this._sourceMapUrl && this._sourceMapUrl.endsWith('-pretty.map'))
      return true;
    const content = await this.content();
    if (!content)
      return false;
    const sourceMapUrl = this.url() + '-pretty.map';
    const fileName = this.url() + '-pretty.js';
    const map = await prettyPrintAsSourceMap(fileName, content);
    if (!map)
      return false;
    this._sourceMapUrl = sourceMapUrl;
    const sourceMap: SourceMapData = { compiled: new Set([this]), map, loaded: Promise.resolve() };
    this._container._sourceMaps.set(sourceMapUrl, sourceMap);
    this._container._addSourceMapSources(this, map, sourceMapUrl);
    return true;
  }

  async toDap(): Promise<Dap.Source> {
    let existingAbsolutePath = await this._existingAbsolutePath;
    const sources = this._sourceMapSourceByUrl
      ? await Promise.all(Array.from(this._sourceMapSourceByUrl.values()).map(s => s.toDap()))
      : undefined;
    if (existingAbsolutePath) {
      return {
        name: this._name,
        path: existingAbsolutePath,
        sourceReference: 0,
        sources,
      };
    }
    return {
      name: this._name,
      path: this._fqname,
      sourceReference: this._sourceReference,
      sources,
    };
  }

  absolutePath(): string {
    return this._absolutePath;
  }

  existingAbsolutePath(): Promise<string | undefined> {
    return this._existingAbsolutePath;
  }

  async prettyName(): Promise<string> {
    const path = await this._existingAbsolutePath;
    if (path)
      return path;
    return this._fqname;
  }

  _fullyQualifiedName(): string {
    if (!this._url)
      return '<eval>/VM' + this._sourceReference;
    let fqname = this._url;
    try {
      const tokens: string[] = [];
      const url = new URL(this._url);
      if (url.protocol === 'data:')
        return '<eval>/VM' + this._sourceReference;
      if (url.hostname)
        tokens.push(url.hostname);
      if (url.port)
        tokens.push('\uA789' + url.port);  // : in unicode
      if (url.pathname)
        tokens.push(url.pathname);
      if (url.searchParams)
        tokens.push(url.searchParams.toString());
      fqname = tokens.join('');
    } catch (e) {
    }
    if (fqname.endsWith('/'))
      fqname += '(index)';
    if (this._inlineScriptOffset)
      fqname = `${fqname}\uA789${this._inlineScriptOffset.lineOffset + 1}:${this._inlineScriptOffset.columnOffset + 1}`;
    return fqname;
  }
};

export class SourceContainer {
  private _dap: Dap.Api;
  _sourcePathResolver: SourcePathResolver;

  private _sourceByReference: Map<number, Source> = new Map();
  private _compiledByUrl: Map<string, Source> = new Map();
  private _sourceMapSourcesByUrl: Map<string, Source> = new Map();
  private _sourceByAbsolutePath: Map<string, Source> = new Map();

  // All source maps by url.
  _sourceMaps: Map<string, SourceMapData> = new Map();
  private _revealer?: LocationRevealer;
  private _sourceMapTimeouts: SourceMapTimeouts = defaultTimeouts;

  constructor(dap: Dap.Api, sourcePathResolver: SourcePathResolver) {
    this._dap = dap;
    this._sourcePathResolver = sourcePathResolver;
  }

  setSourceMapTimeouts(sourceMapTimeouts: SourceMapTimeouts) {
    this._sourceMapTimeouts = sourceMapTimeouts;
  }

  sourceMapTimeouts(): SourceMapTimeouts {
    return this._sourceMapTimeouts;
  }

  installRevealer(revealer: LocationRevealer) {
    this._revealer = revealer;
  }

  sources(): Source[] {
    return Array.from(this._sourceByReference.values());
  }

  source(ref: Dap.Source): Source | undefined {
    if (ref.sourceReference)
      return this._sourceByReference.get(ref.sourceReference);
    if (ref.path)
      return this._sourceByAbsolutePath.get(ref.path);
    return undefined;
  }

  sourceByUrl(url: string): Source | undefined {
    return this._compiledByUrl.get(url);
  }

  async preferredLocation(location: Location): Promise<Location> {
    while (true) {
      if (!location.source)
        return location;
      if (!location.source._sourceMapUrl)
        return location;
      const sourceMap = this._sourceMaps.get(location.source._sourceMapUrl)!;
      await Promise.race([
        sourceMap.loaded,
        new Promise(f => setTimeout(f, this._sourceMapTimeouts.resolveLocation)),
      ]);
      if (!sourceMap.map)
        return location;
      const sourceMapped = this._sourceMappedLocation(location, sourceMap.map);
      if (!sourceMapped)
        return location;
      location = sourceMapped;
    }
  }

  currentSiblingLocations(location: Location, inSource?: Source): Location[] {
    return this._locations(location).filter(location => !inSource || location.source === inSource);
  }

  _locations(location: Location): Location[] {
    const result: Location[] = [];
    this._addSourceMapLocations(location, result);
    result.push(location);
    this._addCompiledLocations(location, result);
    return result;
  }

  _addSourceMapLocations(location: Location, result: Location[]) {
    if (!location.source)
      return;
    if (!location.source._sourceMapUrl)
      return;
    const map = this._sourceMaps.get(location.source._sourceMapUrl)!.map;
    if (!map)
      return;
    const sourceMapLocation = this._sourceMappedLocation(location, map);
    if (!sourceMapLocation)
      return;
    this._addSourceMapLocations(sourceMapLocation, result);
    result.push(sourceMapLocation);
  }

  _sourceMappedLocation(location: Location, map: SourceMapConsumer): Location | undefined {
    const compiled = location.source!;
    if (!compiled._sourceMapSourceByUrl)
      return;

    let { lineNumber, columnNumber } = location;
    if (compiled._inlineScriptOffset) {
      lineNumber -= compiled._inlineScriptOffset.lineOffset;
      if (lineNumber === 1)
        columnNumber -= compiled._inlineScriptOffset.columnOffset;
    }

    const entry = map.originalPositionFor({line: lineNumber, column: columnNumber});
    if (!entry.source)
      return;

    const source = compiled._sourceMapSourceByUrl.get(entry.source);
    if (!source)
      return;

    return {
      lineNumber: entry.line === null ? 1 : entry.line,
      columnNumber: entry.column === null ? 1 : entry.column,
      url: source._url,
      source: source
    };
  }

  _addCompiledLocations(location: Location, result: Location[]) {
    if (!location.source || !location.source._compiledToSourceUrl)
      return;
    for (const [compiled, sourceUrl] of location.source._compiledToSourceUrl) {
      const map = this._sourceMaps.get(compiled._sourceMapUrl!)!.map;
      if (!map)
        continue;
      const entry = map.generatedPositionFor({source: sourceUrl, line: location.lineNumber, column: location.columnNumber});
      if (entry.line === null)
        continue;
      const compiledLocation = {
        lineNumber: entry.line === null ? 1 : entry.line,
        columnNumber: entry.column === null ? 1 : entry.column,
        url: compiled.url(),
        source: compiled
      };
      if (compiled._inlineScriptOffset) {
        compiledLocation.lineNumber += compiled._inlineScriptOffset.lineOffset;
        if (compiledLocation.lineNumber === 1)
          compiledLocation.columnNumber += compiled._inlineScriptOffset.columnOffset;
      }
      result.push(compiledLocation);
      this._addCompiledLocations(compiledLocation, result);
    }
  }

  addSource(url: string, contentGetter: ContentGetter, sourceMapUrl?: string, inlineSourceRange?: InlineScriptOffset): Source {
    console.assert(!url || !this._compiledByUrl.has(url));
    const source = new Source(this, url, contentGetter, sourceMapUrl, inlineSourceRange);
    this._addSource(source);
    return source;
  }

  async _addSource(source: Source) {
    this._sourceByReference.set(source.sourceReference(), source);
    if (source._compiledToSourceUrl)
      this._sourceMapSourcesByUrl.set(source._url, source);
    else if (source._url)
      this._compiledByUrl.set(source._url, source);
    this._sourceByAbsolutePath.set(source._absolutePath, source);
    source.toDap().then(payload => {
      this._dap.loadedSource({ reason: 'new', source: payload });
    });

    const sourceMapUrl = source._sourceMapUrl;
    if (!sourceMapUrl)
      return;

    let sourceMap = this._sourceMaps.get(sourceMapUrl);
    if (sourceMap) {
      sourceMap.compiled.add(source);
      if (sourceMap.map) {
        // If source map has been already loaded, we add sources here.
        // Otheriwse, we'll add sources for all compiled after loading the map.
        this._addSourceMapSources(source, sourceMap.map, sourceMapUrl);
      }
      return;
    }

    let callback: () => void;
    const promise = new Promise<void>(f => callback = f);
    sourceMap = { compiled: new Set([source]), loaded: promise };
    this._sourceMaps.set(sourceMapUrl, sourceMap);
    // Source map could have been detached while loading.
    if (this._sourceMaps.get(sourceMapUrl) !== sourceMap)
      return callback!();

    try {
      sourceMap.map = await loadSourceMap(sourceMapUrl, this._sourceMapTimeouts.load);
    } catch (e) {
      errors.reportToConsole(this._dap, `Could not load source map from ${sourceMapUrl}: ${e}`);
      return callback!();
    }

    for (const anyCompiled of sourceMap.compiled)
      this._addSourceMapSources(anyCompiled, sourceMap.map!, sourceMapUrl);
    callback!();
  }

  removeSource(source: Source) {
    console.assert(this._sourceByReference.get(source.sourceReference()) === source);
    this._sourceByReference.delete(source.sourceReference());
    if (source._compiledToSourceUrl)
      this._sourceMapSourcesByUrl.delete(source._url);
    else if (source._url)
      this._compiledByUrl.delete(source._url);
    this._sourceByAbsolutePath.delete(source._absolutePath);
    source.toDap().then(payload => {
      this._dap.loadedSource({ reason: 'removed', source: payload });
    });

    const sourceMapUrl = source._sourceMapUrl;
    if (!sourceMapUrl)
      return;

    const sourceMap = this._sourceMaps.get(sourceMapUrl)!;
    console.assert(sourceMap.compiled.has(source));
    sourceMap.compiled.delete(source);
    if (!sourceMap.compiled.size) {
      if (sourceMap.map)
        sourceMap.map.destroy();
      this._sourceMaps.delete(sourceMapUrl);
    }
    // Source map could still be loading, or failed to load.
    if (sourceMap.map)
      this._removeSourceMapSources(source, sourceMap.map);
  }

  _addSourceMapSources(compiled: Source, map: SourceMapConsumer, sourceMapUrl: string) {
    compiled._sourceMapSourceByUrl = new Map();
    const addedSources: Source[] = [];
    for (const url of map.sources) {
      const sourceUrl = this._sourcePathResolver.rewriteSourceUrl(url);
      const baseUrl = sourceMapUrl.startsWith('data:') ? compiled.url() : sourceMapUrl;
      const resolvedUrl = utils.completeUrl(baseUrl, sourceUrl) || sourceUrl;
      const contentOrNull = map.sourceContentFor(url);
      const content = contentOrNull === null ? undefined : contentOrNull;
      let source = this._sourceMapSourcesByUrl.get(resolvedUrl);
      const isNew = !source;
      if (!source) {
        // Note: we can support recursive source maps here if we parse sourceMapUrl comment.
        source = new Source(this, resolvedUrl, content !== undefined ? () => Promise.resolve(content) : () => utils.fetch(resolvedUrl));
        source._compiledToSourceUrl = new Map();
      }
      source._compiledToSourceUrl!.set(compiled, url);
      compiled._sourceMapSourceByUrl.set(url, source);
      if (isNew)
        this._addSource(source);
      addedSources.push(source);
    }
  }

  _removeSourceMapSources(compiled: Source, map: SourceMapConsumer) {
    for (const url of map.sources) {
      const source = compiled._sourceMapSourceByUrl!.get(url)!;
      compiled._sourceMapSourceByUrl!.delete(url);
      console.assert(source._compiledToSourceUrl!.has(compiled));
      source._compiledToSourceUrl!.delete(compiled);
      if (source._compiledToSourceUrl!.size)
        continue;
      this.removeSource(source);
    }
  }

  async waitForSourceMapSources(source: Source): Promise<Source[]> {
    if (!source._sourceMapUrl)
      return [];
    const sourceMap = this._sourceMaps.get(source._sourceMapUrl)!;
    await sourceMap.loaded;
    if (!source._sourceMapSourceByUrl)
      return [];
    return Array.from(source._sourceMapSourceByUrl.values());
  }

  async revealLocation(location: Location): Promise<void> {
    if (this._revealer)
      this._revealer.revealLocation(location);
  }
};

async function loadSourceMap(url: string, slowDown: number): Promise<SourceMapConsumer | undefined> {
  if (slowDown)
    await new Promise(f => setTimeout(f, slowDown));
  let content = await utils.fetch(url);
  if (content.slice(0, 3) === ')]}')
    content = content.substring(content.indexOf('\n'));
  return await new sourcemap.SourceMapConsumer(content);
}

function checkExists(absolutePath: string): Promise<string | undefined> {
  return new Promise(f => fs.exists(absolutePath, exists => f(exists ? absolutePath : undefined)));
}
