/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {SourceMap} from './sourceMap';
import {EventEmitter} from 'events';
import * as utils from '../utils';
import Dap from '../dap/api';
import {URL} from 'url';
import * as path from 'path';
import * as fs from 'fs';

export type SourceContentGetter = () => Promise<string | undefined>;

export interface LaunchParams extends Dap.LaunchParams {
  url: string;
  webRoot?: string;
}

export interface Location {
  lineNumber: number;
  columnNumber: number;
  url: string;
  source?: Source;
};

export interface InlineSourceRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
};

type ResolvedPath = {name: string, absolutePath?: string};

export class SourcePathResolver {
  private _webRoot?: string;
  private _rules: {urlPrefix: string, pathPrefix: string}[] = [];
  private _projectRoot?: string;

  initialize(webRoot?: string) {
    this._webRoot = webRoot ? path.normalize(webRoot) : undefined;
    if (!this._webRoot)
      return;
    const substitute = (s: string): string => {
      return s.replace(/${webRoot}/g, this._webRoot!);
    };
    this._rules = [
      {urlPrefix: 'webpack:///./~/', pathPrefix: substitute('${webRoot}/node_modules/')},
      {urlPrefix: 'webpack:///./', pathPrefix: substitute('${webRoot}/')},
      {urlPrefix: 'webpack:///src/', pathPrefix: substitute('${webRoot}/')},
      {urlPrefix: 'webpack:///', pathPrefix: substitute('/')},
    ];
    // TODO(dgozman): perhaps some sort of auto-mapping could be useful here.

    let projectRoot = this._webRoot;
    while (true) {
      if (fs.existsSync(path.join(projectRoot, '.git'))) {
        this._projectRoot = projectRoot;
        break;
      }
      const parent = path.dirname(projectRoot);
      if (projectRoot === parent)
        break;
      projectRoot = parent;
    }
  }

  resolveSourceMapSourceUrl(map: SourceMap, compiled: Source, sourceUrl: string): string {
    if (this._projectRoot && sourceUrl.startsWith(this._projectRoot) && !utils.isValidUrl(sourceUrl))
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
    return {absolutePath, name};
  }

  _resolveAbsolutePath(url: string): string | undefined {
    // TODO(dgozman): make sure all platform paths are supported.
    if (url.startsWith('file://'))
      return url.substring(7);
    for (const rule of this._rules) {
      if (url.startsWith(rule.urlPrefix))
        return rule.pathPrefix + url.substring(rule.pathPrefix.length);
    }
    if (this._webRoot) {
      try {
        let relative = new URL(url).pathname;
        if (relative === '' || relative === '/')
          relative = 'index.html';
        return path.join(this._webRoot, relative);
      } catch (e) {
      }
    }
    return undefined;
  }

  _checkExists(absolutePath: string): boolean {
    // TODO(dgozman): this does not scale. Read it once?
    return fs.existsSync(absolutePath);
  }
}

export class Source {
  private static _lastSourceReference = 0;

  private _sourceReference: number;
  _url: string;
  private _content?: Promise<string | undefined>;
  private _contentGetter: SourceContentGetter;
  _inlineSourceRange?: InlineSourceRange;
  _resolvedPath?: ResolvedPath;

  constructor(url: string, contentGetter: SourceContentGetter) {
    this._sourceReference = ++Source._lastSourceReference;
    this._url = url;
    this._contentGetter = contentGetter;
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

  setInlineSourceRange(inlineSourceRange: InlineSourceRange) {
    this._inlineSourceRange = inlineSourceRange;
  }

  toDap(): Dap.Source {
    // TODO(dgozman): provide Dap.Source.origin?
    let {absolutePath, name} = this._resolvedPath!;
    if (absolutePath) {
      return {
        name: name || '<anonymous>',
        path: absolutePath,
        sourceReference: 0
      };
    }
    if (name && this._inlineSourceRange) {
      // TODO(dgozman): show real html contents if possible.
      name = name + '@' + (this._inlineSourceRange.startLine + 1);
      if (this._inlineSourceRange.startColumn)
        name = name + ':' + (this._inlineSourceRange.startColumn + 1);
    }
    return {
      name: name || '<anonymous>',
      sourceReference: this._sourceReference
    };
  }
};

type SourceData = {source: Source, sourceMapUrl?: string};
type SourceMapData = {compiled: Set<Source>, map?: SourceMap};
type SourceMapSourceData = {counter: number, source: Source};

export class SourceContainer extends EventEmitter {
  private _dap: Dap.Api;
  _sourcePathResolver: SourcePathResolver;
  // All sources by the sourceReference.
  private _sources: Map<number, SourceData> = new Map();
  // All sources reported over Dap with a path are registered here,
  // to be resolved later by the path.
  _sourceByReportedPath: Map<string, Source> = new Map();
  // All source maps by url.
  private _sourceMaps: Map<string, SourceMapData> = new Map();
  // All sources generated from source maps, by resolved url.
  private _sourceMapSources: Map<string, SourceMapSourceData> = new Map();
  private _initialized = false;

  constructor(dap: Dap.Api, sourcePathResolver: SourcePathResolver) {
    super();
    this._dap = dap;
    this._sourcePathResolver = sourcePathResolver;
  }

  sources(): Source[] {
    return Array.from(this._sources.values()).map(data => data.source);
  }

  source(ref: Dap.Source): Source | undefined {
    if (ref.sourceReference) {
      const data = this._sources.get(ref.sourceReference);
      return data && data.source;
    }
    if (ref.path)
      return this._sourceByReportedPath.get(ref.path);
    return undefined;
  }

  createSource(url: string, contentGetter: SourceContentGetter): Source {
    return new Source(url, contentGetter);
  }

  initialize() {
    for (const sourceData of this._sources.values())
      this._initializeAndReportSource(sourceData.source);
    this._initialized = true;
  }

  uiLocation(rawLocation: Location): Location {
    const oneBased = {
      lineNumber: rawLocation.lineNumber + 1,
      columnNumber: rawLocation.columnNumber + 1,
      url: rawLocation.url,
      source: rawLocation.source,
    };
    if (!rawLocation.source)
      return oneBased;

    const compiledData = this._sources.get(rawLocation.source.sourceReference());
    if (!compiledData || !compiledData.sourceMapUrl)
      return oneBased;
    const map = this._sourceMaps.get(compiledData.sourceMapUrl)!.map;
    if (!map)
      return oneBased;

    let {lineNumber, columnNumber} = rawLocation;
    if (rawLocation.source._inlineSourceRange) {
      lineNumber -= rawLocation.source._inlineSourceRange.startLine;
      if (!lineNumber)
        columnNumber -= rawLocation.source._inlineSourceRange.startColumn;
    }
    const entry = map.findEntry(lineNumber, columnNumber);
    if (!entry || !entry.sourceUrl)
      return oneBased;

    const resolvedUrl = this._sourcePathResolver.resolveSourceMapSourceUrl(map, rawLocation.source, entry.sourceUrl);
    const sourceData = this._sourceMapSources.get(resolvedUrl);
    if (!sourceData)
      return oneBased;
    return {
      lineNumber: (entry.sourceLineNumber || 0) + 1,
      columnNumber: (entry.sourceColumnNumber || 0) + 1,
      url: resolvedUrl,
      source: sourceData.source
    };
  }

  addSource(source: Source) {
    this._sources.set(source.sourceReference(), {source});
    if (this._initialized)
      this._initializeAndReportSource(source);
  }

  removeSources(...sources: Source[]) {
    for (const source of sources) {
      if (this._initialized)
        this._dap.loadedSource({reason: 'removed', source: source.toDap()});
      const data = this._sources.get(source.sourceReference())!;
      this._sources.delete(source.sourceReference());
      if (source._resolvedPath && source._resolvedPath.absolutePath)
        this._sourceByReportedPath.delete(source._resolvedPath.absolutePath);
      if (data.sourceMapUrl)
        this._detachSourceMap(source, data.sourceMapUrl);
    }
  }

  async attachSourceMap(compiled: Source, url: string) {
    const sourceData = this._sources.get(compiled.sourceReference())!;
    console.assert(!sourceData.sourceMapUrl);
    sourceData.sourceMapUrl = url;

    let sourceMapData = this._sourceMaps.get(url);
    if (sourceMapData) {
      sourceMapData.compiled.add(compiled);
      if (sourceMapData.map) {
        // If source map has been already loaded, we add sources here.
        // Otheriwse, we'll add sources for all compiled after loading the map.
        this._addSourceMapSources(compiled, sourceMapData.map);
      }
      return;
    }

    sourceMapData = {compiled: new Set([compiled])};
    this._sourceMaps.set(url, sourceMapData);
    // TODO(dgozman): do we need stub source while source map is loading?
    const sourceMap = await SourceMap.load(url);
    // Source map could have been detached while loading.
    if (!sourceMap || this._sourceMaps.get(url) !== sourceMapData)
      return;
    sourceMapData.map = sourceMap;

    for (const anyCompiled of sourceMapData.compiled)
      this._addSourceMapSources(anyCompiled, sourceMap);
  }

  _addSourceMapSources(compiled: Source, map: SourceMap) {
    for (const url of map.sourceUrls()) {
      const resolvedUrl = this._sourcePathResolver.resolveSourceMapSourceUrl(map, compiled, url);
      const sourceData = this._sourceMapSources.get(resolvedUrl);
      if (sourceData) {
        sourceData.counter++;
        continue;
      }
      const content = map.sourceContent(url);
      const source = content === undefined
        ? this.createSource(resolvedUrl, () => utils.fetch(resolvedUrl))
        : this.createSource(resolvedUrl, () => Promise.resolve(content));
      this._sourceMapSources.set(resolvedUrl, {counter: 1, source});
      this.addSource(source);
      // TODO(dgozman): support recursive source maps?
    }
  }

  _detachSourceMap(compiled: Source, url: string) {
    const sourceMapData = this._sourceMaps.get(url)!;
    console.assert(sourceMapData.compiled.size > 0);
    sourceMapData.compiled.delete(compiled);
    if (!sourceMapData.compiled.size)
      this._sourceMaps.delete(url);
    // Source map could still be loading, or failed to load.
    if (sourceMapData.map)
      this._removeSourceMapSources(compiled, sourceMapData.map);
  }

  _removeSourceMapSources(compiled: Source, map: SourceMap) {
    for (const url of map.sourceUrls()) {
      const resolvedUrl = this._sourcePathResolver.resolveSourceMapSourceUrl(map, compiled, url);
      const sourceMapSourceData = this._sourceMapSources.get(resolvedUrl)!;
      if (--sourceMapSourceData.counter > 0)
        continue;
      this._sourceMapSources.delete(resolvedUrl);
      this.removeSources(sourceMapSourceData.source);
    }
  }

  _initializeAndReportSource(source: Source) {
    source._resolvedPath = this._sourcePathResolver.resolveSourcePath(source._url);
    if (source._resolvedPath.absolutePath)
      this._sourceByReportedPath.set(source._resolvedPath.absolutePath, source);
    this._dap.loadedSource({reason: 'new', source: source.toDap()});
  }
};
