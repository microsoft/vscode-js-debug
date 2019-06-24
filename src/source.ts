// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {SourceMap} from './sourceMap';
import {EventEmitter} from 'events';
import * as utils from './utils';

export type SourceContentGetter = () => Promise<string | undefined>;

export interface Location {
  lineNumber: number;
  columnNumber: number;
  url: string;
  source?: Source;
};

export class Source {
  private static _lastSourceReference = 0;

  private _sourceReference: number;
  private _url: string;
  private _content?: Promise<string | undefined>;
  private _contentGetter: SourceContentGetter;

  constructor() {
    this._sourceReference = ++Source._lastSourceReference;
  }

  static createWithContentGetter(url: string, contentGetter: SourceContentGetter): Source {
    const result = new Source();
    result._url = url;
    result._contentGetter = contentGetter;
    return result;
  }

  static createWithContent(url: string, content: string): Source {
    return Source.createWithContentGetter(url, () => Promise.resolve(content));
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
};

type SourceData = {source: Source, sourceMapUrl?: string};
type SourceMapData = {compiled: Set<Source>, map?: SourceMap};
type SourceMapSourceData = {counter: number, source: Source};

export class SourceContainer extends EventEmitter {
  static Events = {
    SourceAdded: Symbol('SourceAdded'),
    SourcesRemoved: Symbol('SourcesRemoved'),
  };

  // TODO(dgozman): this is what create-react-app does. We should be able to auto-detect.
  private _sourceUrlsArePaths = true;

  // All sources by the sourceReference.
  private _sources: Map<number, SourceData> = new Map();
  // All source maps by url.
  private _sourceMaps: Map<string, SourceMapData> = new Map();
  // All sources generated from source maps, by resolved url.
  private _sourceMapSources: Map<string, SourceMapSourceData> = new Map();

  sources(): Source[] {
    return Array.from(this._sources.values()).map(data => data.source);
  }

  source(sourceReference: number): Source | undefined {
    const data = this._sources.get(sourceReference);
    return data && data.source;
  }

  uiLocation(rawLocation: Location): Location {
    if (!rawLocation.source)
      return rawLocation;
    const compiledData = this._sources.get(rawLocation.source.sourceReference());
    if (!compiledData.sourceMapUrl)
      return rawLocation;
    const map = this._sourceMaps.get(compiledData.sourceMapUrl).map;
    if (!map)
      return rawLocation;
    // TODO(dgozman): account for inline scripts which have lineOffset and columnOffset.
    const entry = map.findEntry(rawLocation.lineNumber, rawLocation.columnNumber);
    if (!entry || !entry.sourceUrl)
      return rawLocation;
    const resolvedUrl = this._resolveSourceUrl(map, rawLocation.source, entry.sourceUrl);
    const sourceData = this._sourceMapSources.get(resolvedUrl);
    if (!sourceData)
      return rawLocation;
    return {
      lineNumber: entry.sourceLineNumber,
      columnNumber: entry.sourceColumnNumber,
      url: resolvedUrl,
      source: sourceData.source
    };
  }

  addSource(source: Source) {
    this._sources.set(source.sourceReference(), {source});
    this.emit(SourceContainer.Events.SourceAdded, source);
  }

  removeSources(...sources: Source[]) {
    const removedSourceMapSources = [];
    for (const source of sources) {
      const data = this._sources.get(source.sourceReference());
      if (data.sourceMapUrl)
        removedSourceMapSources.push(...this._detachSourceMap(source, data.sourceMapUrl));
      this._sources.delete(source.sourceReference());
    }
    this.emit(SourceContainer.Events.SourcesRemoved, sources.concat(removedSourceMapSources));
  }

  async attachSourceMap(compiled: Source, url: string) {
    const sourceData = this._sources.get(compiled.sourceReference());
    console.assert(sourceData && !sourceData.sourceMapUrl);
    sourceData.sourceMapUrl = url;

    let sourceMapData = this._sourceMaps.get(url);
    if (sourceMapData) {
      sourceMapData.compiled.add(compiled);
      if (sourceMapData.map) {
        // If source map has been already loaded, we add sources.
        // If it is still loading, we'll add sources for all compiled at once.
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
      const resolvedUrl = this._resolveSourceUrl(map, compiled, url);
      const sourceData = this._sourceMapSources.get(resolvedUrl);
      if (sourceData) {
        sourceData.counter++;
      } else {
        const content = map.sourceContent(url);
        const source = content === undefined
            ? Source.createWithContentGetter(resolvedUrl, () => utils.fetch(resolvedUrl))
            : Source.createWithContent(resolvedUrl, content);
        this._sourceMapSources.set(resolvedUrl, {counter: 1, source});
        this.addSource(source);
        // TODO(dgozman): support recursive source maps?
      }
    }
  }

  _detachSourceMap(compiled: Source, url: string): Source[] {
    const sourceMapData = this._sourceMaps.get(url);
    console.assert(sourceMapData && sourceMapData.compiled.size > 0);
    sourceMapData.compiled.delete(compiled);
    if (!sourceMapData.compiled.size)
      this._sourceMaps.delete(url);

    // Source map could still be loading, or failed to load.
    if (sourceMapData.map)
      return this._removeSourceMapSources(compiled, sourceMapData.map);
    return [];
  }

  _removeSourceMapSources(compiled: Source, map: SourceMap): Source[] {
    const result = [];
    for (const url of map.sourceUrls()) {
      const resolvedUrl = this._resolveSourceUrl(map, compiled, url);
      const sourceData = this._sourceMapSources.get(resolvedUrl);
      if (--sourceData.counter > 0)
        continue;
      this._sourceMapSources.delete(resolvedUrl);
      // TODO(dgozman): support recursive source maps?
      console.assert(!this._sources.get(sourceData.source.sourceReference()).sourceMapUrl);
      this._sources.delete(sourceData.source.sourceReference());
      result.push(sourceData.source);
    }
    return result;
  }

  _resolveSourceUrl(map: SourceMap, compiled: Source, sourceUrl: string): string {
    if (this._sourceUrlsArePaths)
      sourceUrl = 'file://' + sourceUrl;
    const baseUrl = map.url().startsWith('data:') ? compiled.url() : map.url();
    return utils.completeUrl(baseUrl, sourceUrl) || sourceUrl;
  }
};
