// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {SourceMap} from './sourceMap';
import * as utils from '../utils';
import Dap from '../dap/api';
import {URL} from 'url';
import * as path from 'path';
import * as fs from 'fs';
import * as errors from './errors';
import { prettyPrintAsSourceMap } from './prettyPrint';

export interface Location {
  lineNumber: number;
  columnNumber: number;
  url: string;
  source?: Source;
};

type ContentGetter = () => Promise<string | undefined>;
type InlineSourceRange = {startLine: number, startColumn: number, endLine: number, endColumn: number};
type ResolvedPath = {name: string, absolutePath?: string, nodeModule?: string};
type SourceMapData = {compiled: Set<Source>, map?: SourceMap, loaded: Promise<void>};

export class SourcePathResolver {
  private _basePath?: string;
  private _baseUrl?: URL;
  private _rules: {urlPrefix: string, pathPrefix: string}[] = [];
  private _gitRoot?: string;
  private _nodeModulesRoot?: string;

  initialize(url: string, webRoot: string | undefined) {
    this._basePath = webRoot ? path.normalize(webRoot) : undefined;
    try {
      this._baseUrl = new URL(url);
      this._baseUrl.pathname = '/';
      this._baseUrl.search = '';
      this._baseUrl.hash = '';
    } catch (e) {
      this._baseUrl = undefined;
    }

    if (!this._basePath)
      return;
    const substitute = (s: string): string => {
      return s.replace(/${webRoot}/g, this._basePath!);
    };
    this._rules = [
      {urlPrefix: 'webpack:///./~/', pathPrefix: substitute('${webRoot}/node_modules/')},
      {urlPrefix: 'webpack:///./', pathPrefix: substitute('${webRoot}/')},
      {urlPrefix: 'webpack:///src/', pathPrefix: substitute('${webRoot}/')},
      {urlPrefix: 'webpack:///', pathPrefix: substitute('/')},
    ];

    this._gitRoot = this._findProjectDirWith('.git') + path.sep;
    const packageRoot = this._findProjectDirWith('package.json');
    if (packageRoot)
      this._nodeModulesRoot = path.join(packageRoot, 'node_modules') + path.sep;
  }

  _findProjectDirWith(entryName: string): string | undefined {
    let dir = this._basePath!;
    while (true) {
      try {
        if (fs.existsSync(path.join(dir, entryName)))
          return dir;
      } catch (e) {
        return undefined;
      }
      const parent = path.dirname(dir);
      if (dir === parent)
        break;
      dir = parent;
    }
  }

  resolveSourceMapSourceUrl(map: SourceMap, compiled: Source, sourceUrl: string): string {
    if (this._gitRoot && sourceUrl.startsWith(this._gitRoot) && !utils.isValidUrl(sourceUrl))
      sourceUrl = 'file://' + sourceUrl;
    const baseUrl = map.url().startsWith('data:') ? compiled.url() : map.url();
    return utils.completeUrl(baseUrl, sourceUrl) || sourceUrl;
  }

  resolveSourcePath(url?: string): ResolvedPath {
    if (!url)
      return {name: ''};
    let absolutePath = this._resolveAbsolutePath(url);
    if (!absolutePath)
      return {name: path.basename(url || '')};
    const name = path.basename(absolutePath);
    if (!this._checkExists(absolutePath))
      return {name};
    if (this._nodeModulesRoot && absolutePath.startsWith(this._nodeModulesRoot)) {
      const relative = absolutePath.substring(this._nodeModulesRoot.length);
      const sepIndex = relative.indexOf(path.sep);
      const nodeModule = sepIndex === -1 ? relative : relative.substring(0, sepIndex);
      return {absolutePath, name, nodeModule};
    }
    return {absolutePath, name};
  }

  resolveUrl(absolutePath: string): string | undefined {
    absolutePath = path.normalize(absolutePath);
    if (!this._baseUrl || !this._basePath || !absolutePath.startsWith(this._basePath))
      return 'file://' + absolutePath;
    const relative = path.relative(this._basePath, absolutePath);
    try {
      return new URL(relative, this._baseUrl).toString();
    } catch (e) {
    }
  }

  _resolveAbsolutePath(url: string): string | undefined {
    // TODO(dgozman): make sure all platform paths are supported.
    if (url.startsWith('file://'))
      return url.substring(7);
    for (const rule of this._rules) {
      if (url.startsWith(rule.urlPrefix))
        return rule.pathPrefix + url.substring(rule.pathPrefix.length);
    }
    if (!this._basePath || !this._baseUrl)
      return;

    try {
      const u = new URL(url);
      if (u.origin !== this._baseUrl.origin)
        return;
      const pathname = path.normalize(u.pathname);
      let basepath = path.normalize(this._baseUrl.pathname);
      if (!basepath.endsWith(path.sep))
        basepath += path.sep;
      if (!pathname.startsWith(basepath))
        return;
      let relative = basepath === pathname ? '' : path.normalize(path.relative(basepath, pathname));
      if (relative === '' || relative === '/')
        relative = 'index.html';
      return path.join(this._basePath, relative);
    } catch (e) {
    }
  }

  _checkExists(absolutePath: string): boolean {
    // TODO(dgozman): this does not scale. Read it once?
    return fs.existsSync(absolutePath);
  }
}

export class Source {
  private static _lastSourceReference = 0;

  _sourceReference: number;
  _url: string;
  _contentGetter: ContentGetter;
  _sourceMapUrl?: string;
  _inlineSourceRange?: InlineSourceRange;
  _container: SourceContainer;
  _resolvedPath: ResolvedPath;

  // Sources generated for this compiled from it's source map. Exclusive with |_origin|.
  _sourceMapSourceByUrl?: Map<string, Source>;
  // SourceUrl (as listed in source map) for each compiled referencing this source.
  // Exclusive with |_sourceMapSourceByUrl|.
  _compiledToSourceUrl?: Map<Source, string>;

  private _content?: Promise<string | undefined>;

  constructor(container: SourceContainer, url: string, contentGetter: ContentGetter, sourceMapUrl?: string, inlineSourceRange?: InlineSourceRange) {
    this._sourceReference = ++Source._lastSourceReference;
    this._url = url;
    this._contentGetter = contentGetter;
    this._sourceMapUrl = sourceMapUrl;
    this._inlineSourceRange = inlineSourceRange;
    this._container = container;
    this._resolvedPath = container._sourcePathResolver.resolveSourcePath(url);
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
    // TODO(pfeldman): consider checking !this._sourceMapUrl
    return !!this._container;
  }

  async prettyPrint(): Promise<Source | undefined> {
    if (!this._container || !this.canPrettyPrint())
      return;
    const content = await this.content();
    if (!content)
      return;
    const sourceMapUrl = this.url() + '@map';
    const prettyPath = this._resolvedPath.name + '-pretty.js';
    const map = prettyPrintAsSourceMap(prettyPath,  content);
    if (!map)
      return;
    this._sourceMapUrl = sourceMapUrl;
    const sourceMap: SourceMapData = {compiled: new Set([this]), map, loaded: Promise.resolve()};
    this._container._sourceMaps.set(sourceMapUrl, sourceMap);
    const result = this._container._addSourceMapSources(this, map);
    return result[0];
  }

  toDap(): Dap.Source {
    let {absolutePath, name, nodeModule} = this._resolvedPath;
    const sources = this._sourceMapSourceByUrl
      ? Array.from(this._sourceMapSourceByUrl.values()).map(s => s.toDap())
      : undefined;
    if (absolutePath) {
      return {
        name: name || ('VM' + this._sourceReference),
        path: absolutePath,
        sourceReference: 0,
        origin: nodeModule,
        sources,
      };
    }
    if (name && this._inlineSourceRange) {
      name = name + '(VM' + this._sourceReference + ')';
    }
    return {
      name: name || ('VM' + this._sourceReference),
      path: name || ('VM' + this._sourceReference),
      sourceReference: this._sourceReference,
      origin: nodeModule,
      sources,
    };
  }

  absolutePath(): string | undefined {
    return this._resolvedPath.absolutePath;
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
  private _initialized = false;

  constructor(dap: Dap.Api, sourcePathResolver: SourcePathResolver) {
    this._dap = dap;
    this._sourcePathResolver = sourcePathResolver;
  }

  initialized() {
    return this._initialized;
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

  initialize() {
    console.assert(!this._sourceByReference.size);
    this._initialized = true;
  }

  uiLocation(rawLocation: Location): Location {
    const location = this._uiLocation(rawLocation);
    return {
      lineNumber: location.lineNumber + 1,
      columnNumber: location.columnNumber + 1,
      url: location.url,
      source: location.source,
    };
  }

  uiLocationInSource(rawLocation: Location, source: Source): Location | undefined {
    const location = this._uiLocation(rawLocation, source);
    if (location.source !== source)
      return undefined;
    return {
      lineNumber: location.lineNumber + 1,
      columnNumber: location.columnNumber + 1,
      url: location.url,
      source: location.source,
    };
  }

  rawLocations(uiLocation: Location): Location[] {
    uiLocation = {
      lineNumber: uiLocation.lineNumber - 1,
      columnNumber: uiLocation.columnNumber - 1,
      url: uiLocation.url,
      source: uiLocation.source,
    };
    return this._rawLocations(uiLocation);
  }

  _uiLocation(rawLocation: Location, preferredSource?: Source): Location {
    if (!rawLocation.source || rawLocation.source === preferredSource)
      return rawLocation;

    if (!rawLocation.source._sourceMapUrl || !rawLocation.source._sourceMapSourceByUrl)
      return rawLocation;
    const map = this._sourceMaps.get(rawLocation.source._sourceMapUrl)!.map;
    if (!map)
      return rawLocation;

    let {lineNumber, columnNumber} = rawLocation;
    if (rawLocation.source._inlineSourceRange) {
      lineNumber -= rawLocation.source._inlineSourceRange.startLine;
      if (!lineNumber)
        columnNumber -= rawLocation.source._inlineSourceRange.startColumn;
    }
    const entry = map.findEntry(lineNumber, columnNumber);
    if (!entry || !entry.sourceUrl)
      return rawLocation;

    const source = rawLocation.source._sourceMapSourceByUrl.get(entry.sourceUrl);
    if (!source)
      return rawLocation;

    return this._uiLocation({
      lineNumber: entry.sourceLineNumber || 0,
      columnNumber: entry.sourceColumnNumber || 0,
      url: source._url,
      source: source
    });
  }

  _rawLocations(uiLocation: Location): Location[] {
    if (!uiLocation.source || !uiLocation.source._compiledToSourceUrl)
      return [uiLocation];
    const result: Location[] = [];
    for (const [compiled, sourceUrl] of uiLocation.source._compiledToSourceUrl) {
      const map = this._sourceMaps.get(compiled._sourceMapUrl!)!.map;
      if (!map)
        continue;
      const entry = map.findReverseEntry(sourceUrl, uiLocation.lineNumber, uiLocation.columnNumber);
      if (!entry)
        continue;
      result.push(...this._rawLocations({
        lineNumber: entry.lineNumber + (compiled._inlineSourceRange ? compiled._inlineSourceRange.startLine : 0),
        columnNumber: entry.columnNumber + ((compiled._inlineSourceRange && !entry.lineNumber) ? compiled._inlineSourceRange.startColumn : 0),
        url: compiled.url(),
        source: compiled
      }));
    }
    return result;
  }

  addSource(url: string, contentGetter: ContentGetter, sourceMapUrl?: string, inlineSourceRange?: InlineSourceRange): Source {
    console.assert(this._initialized);
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
    if (source._resolvedPath.absolutePath)
      this._sourceByAbsolutePath.set(source._resolvedPath.absolutePath, source);
    this._dap.loadedSource({reason: 'new', source: source.toDap()});

    const sourceMapUrl = source._sourceMapUrl;
    if (!sourceMapUrl)
      return;

    let sourceMap = this._sourceMaps.get(sourceMapUrl);
    if (sourceMap) {
      sourceMap.compiled.add(source);
      if (sourceMap.map) {
        // If source map has been already loaded, we add sources here.
        // Otheriwse, we'll add sources for all compiled after loading the map.
        this._addSourceMapSources(source, sourceMap.map);
      }
      return;
    }

    let callback: () => void;
    const promise = new Promise<void>(f => callback = f);
    sourceMap = {compiled: new Set([source]), loaded: promise};
    this._sourceMaps.set(sourceMapUrl, sourceMap);
    // TODO(dgozman): use timeout to avoid long pauses on script loading.
    sourceMap.map = await SourceMap.load(sourceMapUrl);
    // Source map could have been detached while loading.
    if (this._sourceMaps.get(sourceMapUrl) !== sourceMap)
      return callback!();
    if (!sourceMap.map) {
      errors.reportToConsole(this._dap, `Could not load source map from ${sourceMapUrl}`);
      return callback!();
    }

    for (const error of sourceMap.map!.errors())
      errors.reportToConsole(this._dap, error);
    for (const anyCompiled of sourceMap.compiled)
      this._addSourceMapSources(anyCompiled, sourceMap.map!);
    callback!();
  }

  removeSource(source: Source) {
    console.assert(this._initialized);
    console.assert(this._sourceByReference.get(source.sourceReference()) === source);
    this._dap.loadedSource({reason: 'removed', source: source.toDap()});
    this._sourceByReference.delete(source.sourceReference());
    if (source._compiledToSourceUrl)
      this._sourceMapSourcesByUrl.delete(source._url);
    else if (source._url)
      this._compiledByUrl.delete(source._url);
    if (source._resolvedPath.absolutePath)
      this._sourceByAbsolutePath.delete(source._resolvedPath.absolutePath);

    const sourceMapUrl = source._sourceMapUrl;
    if (!sourceMapUrl)
      return;

    const sourceMap = this._sourceMaps.get(sourceMapUrl)!;
    console.assert(sourceMap.compiled.has(source));
    sourceMap.compiled.delete(source);
    if (!sourceMap.compiled.size)
      this._sourceMaps.delete(sourceMapUrl);
    // Source map could still be loading, or failed to load.
    if (sourceMap.map)
      this._removeSourceMapSources(source, sourceMap.map);
  }

  _addSourceMapSources(compiled: Source, map: SourceMap): Source[] {
    compiled._sourceMapSourceByUrl = new Map();
    const addedSources: Source[] = [];
    for (const url of map.sourceUrls()) {
      // TODO(dgozman): |resolvedUrl| may be equal to compiled url - we may need to distinguish them.
      const resolvedUrl = this._sourcePathResolver.resolveSourceMapSourceUrl(map, compiled, url);
      const content = map.sourceContent(url);
      let source = this._sourceMapSourcesByUrl.get(resolvedUrl);
      const isNew = !source;
      if (!source) {
        // TODO(dgozman): support recursive source maps?
        source = new Source(this, resolvedUrl, content !== undefined ? () => Promise.resolve(content) : () => utils.fetch(resolvedUrl));
        source._compiledToSourceUrl = new Map();
      }
      source._compiledToSourceUrl!.set(compiled, url);
      compiled._sourceMapSourceByUrl.set(url, source);
      if (isNew)
        this._addSource(source);
      addedSources.push(source);
    }
    return addedSources;
  }

  _removeSourceMapSources(compiled: Source, map: SourceMap) {
    for (const url of map.sourceUrls()) {
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
};
