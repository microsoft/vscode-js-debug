// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {DebugProtocol} from 'vscode-debugprotocol';
import {SourceMap} from './sourceMap';
import {EventEmitter} from 'events';

export type SourceContentGetter = () => Promise<string | undefined>;

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

  toDap(): DebugProtocol.Source {
    return {
      name: this._url || '<anonymous>',
      sourceReference: this._sourceReference,
      presentationHint: 'normal'
    };
  }
};

export class SourceContainer extends EventEmitter {
  static Events = {
    SourceAdded: Symbol('SourceAdded'),
    SourcesRemoved: Symbol('SourcesRemoved'),
  };

  private _sources: Map<number, {source: Source, sourceMapUrl?: string}> = new Map();
  private _sourceMaps: Map<string, {counter: number, map: Promise<SourceMap | undefined>}> = new Map();

  sources(): Source[] {
    return Array.from(this._sources.values()).map(data => data.source);
  }

  source(sourceReference: number): Source | undefined {
    const data = this._sources.get(sourceReference);
    return data && data.source;
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
        removedSourceMapSources.push(...this._detachSourceMap(data.sourceMapUrl));
      this._sources.delete(source.sourceReference());
    }
    this.emit(SourceContainer.Events.SourcesRemoved, sources.concat(removedSourceMapSources));
  }

  async attachSourceMap(source: Source, url: string) {
    const data = this._sources.get(source.sourceReference());
    console.assert(data && !data.sourceMapUrl);
    data.sourceMapUrl = url;
    if (this._sourceMaps.has(url)) {
      this._sourceMaps.get(url).counter++;
      return;
    }
    this._sourceMaps.set(url, {counter: 1, map: SourceMap.load(url)});
    // add sources
  }

  _detachSourceMap(url: string): Source[] {
    const data = this._sourceMaps.get(url);
    console.assert(data && data.counter > 0);
    if (!--data.counter) {
      this._sourceMaps.delete(url);
      // remove sources
    }
    return [];
  }
};
