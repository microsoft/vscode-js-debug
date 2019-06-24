// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {URL} from 'url';
import * as utils from './utils';

export class SourceMap {
  private static _base64Map: Object;
  private _json: SourceMapV3;
  private _url: string;
  private _mappings?: SourceMapEntry[];
  private _sourceInfos: Map<string, SourceInfo> = new Map();

  static async load(url: string): Promise<SourceMap | undefined> {
    let content;
    try {
      content = utils.fetch(url);
    } catch (e) {
      return;
    }

    if (content.slice(0, 3) === ')]}')
      content = content.substring(content.indexOf('\n'));
    try {
      const payload = JSON.parse(content) as SourceMapV3;
      return new SourceMap(url, payload);
    } catch (e) {
      return;
    }
  }

  constructor(url: string, payload: SourceMapV3) {
    if (!SourceMap._base64Map) {
      const base64Digits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      SourceMap._base64Map = {};
      for (let i = 0; i < base64Digits.length; ++i)
        SourceMap._base64Map[base64Digits.charAt(i)] = i;
    }

    this._json = payload;
    this._url = url;

    this._mappings = null;
    if (this._json.sections) {
      const sectionWithUrl = !!this._json.sections.find(section => !!section['url']);
      if (sectionWithUrl) {
        // TODO(dgozman): report this error.
        console.error(`SourceMap "${this._url}" contains unsupported "URL" field in one of its sections.`);
      }
    }
    this._forEachSection(map => {
      let sourceRoot = map.sourceRoot || '';
      if (sourceRoot && !sourceRoot.endsWith('/'))
        sourceRoot += '/';
      for (let i = 0; i < map.sources.length; ++i) {
        const url = sourceRoot + map.sources[i];
        map.sources[i] = url;
        const source = map.sourcesContent && map.sourcesContent[i];
        // TODO(dgozman): |url| may be equal to compiled url - we may need to distinguish them.
        this._sourceInfos.set(url, new SourceInfo(source, null));
      }
    });
  }

  _forEachSection(callback: (map: SourceMapV3, line: number, column: number) => void) {
    if (!this._json.sections) {
      callback(this._json, 0, 0);
      return;
    }
    for (const section of this._json.sections)
      callback(section.map, section.offset.line, section.offset.column);
  }

  _baseUrl(compiledUrl: string): string {
    return this._url.startsWith('data:') ? compiledUrl : this._url;
  }

  _sourceUrl(url: string, compiledUrl: string): string {
    const base = this._baseUrl(compiledUrl);
    try {
      return new URL(url, base).href;
    } catch (e) {
      return url;
    }
  }
};

class SourceMapEntry {
  lineNumber: number;
  columnNumber: number;
  sourceUrl?: string;
  sourceLineNumber?: number;
  sourceColumnNumber?: number;
  name?: string;

  constructor(lineNumber: number, columnNumber: number, sourceUrl?: string, sourceLineNumber?: number, sourceColumnNumber?: number, name?: string) {
    this.lineNumber = lineNumber;
    this.columnNumber = columnNumber;
    this.sourceUrl = sourceUrl;
    this.sourceLineNumber = sourceLineNumber;
    this.sourceColumnNumber = sourceColumnNumber;
    this.name = name;
  }

  static compare(entry1: SourceMapEntry, entry2: SourceMapEntry) {
    if (entry1.lineNumber !== entry2.lineNumber)
      return entry1.lineNumber - entry2.lineNumber;
    return entry1.columnNumber - entry2.columnNumber;
  }
};

class SourceInfo {
  content?: string;
  reverseMappings?: SourceMapEntry[];

  constructor(content?: string, reverseMappings?: SourceMapEntry[]) {
    this.content = content;
    this.reverseMappings = reverseMappings;
  }
};

interface SourceMapV3 {
  version: number;
  file?: string;
  sources: string[];
  sourcesContent?: string[];
  sections?: SourceMapV3Section[];
  mappings: string;
  sourceRoot?: string;
  names?: string[];
};

interface SourceMapV3Section {
  offset: SourceMapV3Offset;
  map: SourceMapV3;
};

interface SourceMapV3Offset {
  line: number;
  column: number;
};
