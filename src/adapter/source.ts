// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {SourceMap} from './sourceMap';
import {EventEmitter} from 'events';
import * as utils from '../utils';
import Dap from '../dap/api';
import {URL} from 'url';
import * as path from 'path';
import * as fs from 'fs';
import * as nls from 'vscode-nls';
import * as errors from './errors';

const localize = nls.loadMessageBundle();

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

type ContentGetter = () => Promise<string | undefined>;
type InlineSourceRange = {startLine: number, startColumn: number, endLine: number, endColumn: number};
type ResolvedPath = {name: string, absolutePath?: string, nodeModule?: string, isDirectDependency?: boolean};
type SourceMapData = {compiled: Set<Source>, map?: SourceMap};
type SourceOrigin = {compiled: Set<Source>, inlined: boolean};

export class SourcePathResolver {
  private _webRoot?: string;
  private _rules: {urlPrefix: string, pathPrefix: string}[] = [];
  private _gitRoot?: string;
  private _nodeModulesRoot?: string;
  private _directDependencies = new Set<string>();

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

    this._gitRoot = this._findProjectDirWith('.git') + path.sep;
    const packageRoot = this._findProjectDirWith('package.json');
    if (packageRoot) {
      this._nodeModulesRoot = path.join(packageRoot, 'node_modules') + path.sep;
      try {
        const json = fs.readFileSync(path.join(packageRoot, 'package.json'), {encoding: 'utf-8'});
        const pkg = JSON.parse(json);
        this._directDependencies = new Set(Object.keys(pkg.dependencies || {}));
      } catch (e) {
      }
    }
  }

  _findProjectDirWith(entryName: string): string | undefined {
    let dir = this._webRoot!;
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
      const isDirectDependency = this._directDependencies.has(nodeModule);
      return {absolutePath, name, nodeModule, isDirectDependency}
    }
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

  _sourceReference: number;
  _url: string;
  _contentGetter: ContentGetter;
  _sourceMapUrl?: string;
  _inlineSourceRange?: InlineSourceRange;
  _resolvedPath?: ResolvedPath;
  _container?: SourceContainer;

  // Sources generated for this compiled from it's source map. Exclusive with |_origin|.
  _sourceMapSourceByUrl?: Map<string, Source>;
  // Origin for the sources from the source map. Exclusive with |_sourceMapSourceByUrl|.
  _origin?: SourceOrigin;

  private _content?: Promise<string | undefined>;

  constructor(url: string, contentGetter: ContentGetter, sourceMapUrl?: string, inlineSourceRange?: InlineSourceRange) {
    this._sourceReference = ++Source._lastSourceReference;
    this._url = url;
    this._contentGetter = contentGetter;
    this._sourceMapUrl = sourceMapUrl;
    this._inlineSourceRange = inlineSourceRange;
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

  toDap(): Dap.Source {
    let {absolutePath, name, nodeModule, isDirectDependency} = this._resolvedPath!;
    let deemphasize = false;
    let subtle = false;
    let origin: string | undefined;
    if (this._origin && !absolutePath) {
      origin = this._origin.inlined
        ? localize('sourceOrigin.inlinedInSourceMap', 'from source map, inlined')
        : localize('sourceOrigin.fetchedFromSourceMap', 'from source map, {0}', this._url);
      deemphasize = true;
    } else if (nodeModule && !isDirectDependency) {
      origin = nodeModule;
      deemphasize = true;
    } else if (nodeModule) {
      subtle = true;
    }
    const presentationHint = deemphasize ? 'deemphasize' : (subtle ? 'subtle' : undefined);
    const sources = this._sourceMapSourceByUrl
      ? Array.from(this._sourceMapSourceByUrl.values()).map(s => s.toDap())
      : undefined;
    if (absolutePath) {
      return {
        name: name || ('VM' + this._sourceReference),
        path: absolutePath,
        sourceReference: 0,
        presentationHint,
        origin,
        sources,
      };
    }
    if (name && this._inlineSourceRange) {
      // TODO(dgozman): show real html contents if possible.
      name = name + '@' + (this._inlineSourceRange.startLine + 1);
      if (this._inlineSourceRange.startColumn)
        name = name + ':' + (this._inlineSourceRange.startColumn + 1);
    }
    return {
      name: name || ('VM' + this._sourceReference),
      path: name || ('VM' + this._sourceReference),
      sourceReference: this._sourceReference,
      presentationHint,
      origin,
      sources,
    };
  }
};

export class SourceContainer extends EventEmitter {
  private _dap: Dap.Api;
  _sourcePathResolver: SourcePathResolver;

  private _sourceByReference: Map<number, Source> = new Map();
  private _sourceByPath: Map<string, Source> = new Map();
  // Sources originating from source maps, fetched from a url
  // (as opposite to inlined sources with content provided in the source map).
  // We merge them to a single source per url.
  private _fetchedSourceMapSources: Map<string, Source> = new Map();

  // All source maps by url.
  private _sourceMaps: Map<string, SourceMapData> = new Map();
  private _initialized = false;

  constructor(dap: Dap.Api, sourcePathResolver: SourcePathResolver) {
    super();
    this._dap = dap;
    this._sourcePathResolver = sourcePathResolver;
  }

  sources(): Source[] {
    return Array.from(this._sourceByReference.values());
  }

  source(ref: Dap.Source): Source | undefined {
    if (ref.sourceReference)
      return this._sourceByReference.get(ref.sourceReference);
    if (ref.path)
      return this._sourceByPath.get(ref.path);
    return undefined;
  }

  initialize() {
    for (const source of this._sourceByReference.values())
      this._initializeAndReportSource(source);
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

  _uiLocation(rawLocation: Location): Location {
    if (!rawLocation.source)
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

  async addSource(source: Source) {
    console.assert(!source._container);
    source._container = this;
    this._sourceByReference.set(source.sourceReference(), source);
    if (source._origin && !source._origin.inlined)
      this._fetchedSourceMapSources.set(source._url, source);
    if (this._initialized)
      this._initializeAndReportSource(source);

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

    sourceMap = {compiled: new Set([source])};
    this._sourceMaps.set(sourceMapUrl, sourceMap);
    // TODO(dgozman): do we need stub source while source map is loading?
    sourceMap.map = await SourceMap.load(sourceMapUrl);
    // Source map could have been detached while loading.
    if (!sourceMap || this._sourceMaps.get(sourceMapUrl) !== sourceMap)
      return;

    for (const error of sourceMap.map!.errors())
      errors.reportToConsole(this._dap, error);
    for (const anyCompiled of sourceMap.compiled)
      this._addSourceMapSources(anyCompiled, sourceMap.map!);
  }

  removeSource(source: Source) {
    if (this._initialized)
      this._dap.loadedSource({reason: 'removed', source: source.toDap()});
    this._sourceByReference.delete(source.sourceReference());
    if (source._resolvedPath && source._resolvedPath.absolutePath)
      this._sourceByPath.delete(source._resolvedPath.absolutePath);
    if (source._origin && !source._origin.inlined)
      this._fetchedSourceMapSources.delete(source._url);
    source._container = undefined;

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

  _addSourceMapSources(compiled: Source, map: SourceMap) {
    compiled._sourceMapSourceByUrl = new Map();
    for (const url of map.sourceUrls()) {
      // TODO(dgozman): |resolvedUrl| may be equal to compiled url - we may need to distinguish them.
      const resolvedUrl = this._sourcePathResolver.resolveSourceMapSourceUrl(map, compiled, url);
      const content = map.sourceContent(url);
      const inlined = content !== undefined;
      let source: Source | undefined;
      if (!inlined)
        source = this._fetchedSourceMapSources.get(resolvedUrl);
      if (source) {
        source._origin!.compiled.add(compiled);
        compiled._sourceMapSourceByUrl.set(url, source);
        continue;
      }
      // TODO(dgozman): support recursive source maps?
      source = new Source(resolvedUrl, inlined ? () => Promise.resolve(content) : () => utils.fetch(resolvedUrl));
      source._origin = {compiled: new Set([compiled]), inlined};
      compiled._sourceMapSourceByUrl.set(url, source);
      this.addSource(source);
    }
  }

  _removeSourceMapSources(compiled: Source, map: SourceMap) {
    for (const url of map.sourceUrls()) {
      const source = compiled._sourceMapSourceByUrl!.get(url)!;
      compiled._sourceMapSourceByUrl!.delete(url);
      console.assert(source._origin!.compiled.has(compiled));
      source._origin!.compiled.delete(compiled);
      if (source._origin!.compiled.size)
        continue;
      this.removeSource(source);
    }
  }

  _initializeAndReportSource(source: Source) {
    source._resolvedPath = this._sourcePathResolver.resolveSourcePath(source._url);
    if (source._resolvedPath.absolutePath)
      this._sourceByPath.set(source._resolvedPath.absolutePath, source);
    this._dap.loadedSource({reason: 'new', source: source.toDap()});
  }
};
