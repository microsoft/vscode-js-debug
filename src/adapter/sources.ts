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
type SourceMapData = {compiled: Set<Source>, map?: SourceMap, loaded: Promise<void>};

export interface LocationRevealer {
  revealLocation(location: Location): Promise<void>;
}

export class SourcePathResolver {
  private _basePath?: string;
  private _baseUrl?: URL;
  private _rules: {urlPrefix: string, pathPrefix: string}[] = [];
  private _gitRoot?: string;

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

    // TODO(dgozman): use workspace folder.
    this._gitRoot = this._findProjectDirWith('.git') + path.sep;
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

  async resolveExistingAbsolutePath(url?: string): Promise<string> {
    if (!url)
      return '';
    let absolutePath = this._resolveAbsolutePath(url);
    if (!absolutePath)
      return '';
    if (!await this._checkExists(absolutePath))
      return '';
    return absolutePath;
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

  _checkExists(absolutePath: string): Promise<boolean> {
    return new Promise(f => fs.exists(absolutePath, f));
  }
}

export class Source {
  private static _lastSourceReference = 0;

  _sourceReference: number;
  _url: string;
  _name: string;
  _fqname: string;
  _contentGetter: ContentGetter;
  _sourceMapUrl?: string;
  _inlineSourceRange?: InlineSourceRange;
  _container: SourceContainer;
  _absolutePath: Promise<string>;

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
    this._fqname = this._fullyQualifiedName();
    this._name = path.basename(this._fqname);
    this._absolutePath = container._sourcePathResolver.resolveExistingAbsolutePath(url);
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
    const prettyPath = this._fqname + '-pretty.js';
    const map = prettyPrintAsSourceMap(prettyPath,  content);
    if (!map)
      return;
    this._sourceMapUrl = sourceMapUrl;
    const sourceMap: SourceMapData = {compiled: new Set([this]), map, loaded: Promise.resolve()};
    this._container._sourceMaps.set(sourceMapUrl, sourceMap);
    const result = this._container._addSourceMapSources(this, map);
    return result[0];
  }

  async toDap(): Promise<Dap.Source> {
    let absolutePath = await this._absolutePath;
    const sources = this._sourceMapSourceByUrl
      ? await Promise.all(Array.from(this._sourceMapSourceByUrl.values()).map(s => s.toDap()))
      : undefined;
    if (absolutePath) {
      return {
        name: this._name,
        path: absolutePath,
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

  async absolutePath(): Promise<string | undefined> {
    return this._absolutePath;
  }

  _fullyQualifiedName(): string {
    if (!this._url)
      return 'VM' + this._sourceReference;
    let fqname = this._url;
    try {
      const tokens: string[] = [];
      const url = new URL(this._url);
      if (url.protocol)
        tokens.push(url.protocol.replace(':', '') + '\uA789 ');  // : in unicode
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
      fqname = fqname.substring(0, fqname.length - 1);
    if (this._inlineSourceRange)
      return fqname + '/VM' + this._sourceReference;
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
  private _initialized = false;
  private _revealer?: LocationRevealer;

  constructor(dap: Dap.Api, sourcePathResolver: SourcePathResolver) {
    this._dap = dap;
    this._sourcePathResolver = sourcePathResolver;
  }

  installRevealer(revealer: LocationRevealer) {
    this._revealer = revealer;
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

    source._absolutePath.then(absolutePath => {
      if (absolutePath && this._sourceByReference.get(source.sourceReference()) === source)
        this._sourceByAbsolutePath.set(absolutePath, source);
    });
    source.toDap().then(payload => {
      this._dap.loadedSource({reason: 'new', source: payload});
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
    this._sourceByReference.delete(source.sourceReference());
    if (source._compiledToSourceUrl)
      this._sourceMapSourcesByUrl.delete(source._url);
    else if (source._url)
      this._compiledByUrl.delete(source._url);

    source.absolutePath().then(absolutePath => {
      if (absolutePath && this._sourceByAbsolutePath.get(absolutePath) === source)
        this._sourceByAbsolutePath.delete(absolutePath);
    });
    source.toDap().then(payload => {
      this._dap.loadedSource({reason: 'removed', source: payload});
    });

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

  async revealLocation(location: Location): Promise<void> {
    if (this._revealer)
      this._revealer.revealLocation(location);
  }
};
