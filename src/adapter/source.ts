/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { relative } from 'path';
import { URL } from 'url';
import Cdp from '../cdp/api';
import { checkContentHash } from '../common/hash/checkContentHash';
import { node15InternalsPrefix, nodeInternalsToken } from '../common/node15Internal';
import { once } from '../common/objUtils';
import { forceForwardSlashes, isSubdirectoryOf } from '../common/pathUtils';
import { delay, getDeferred, IDeferred } from '../common/promiseUtil';
import { ISourceMapMetadata, SourceMap } from '../common/sourceMaps/sourceMap';
import { InlineScriptOffset } from '../common/sourcePathResolver';
import * as sourceUtils from '../common/sourceUtils';
import { prettyPrintAsSourceMap } from '../common/sourceUtils';
import * as utils from '../common/urlUtils';
import Dap from '../dap/api';
import { IWasmSymbols } from './dwarf/wasmSymbolProvider';
import type { SourceContainer } from './sourceContainer';

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
  public readonly sourceReference: number;
  private readonly _name: string;
  private readonly _fqname: string;

  /**
   * Function to retrieve the content of the source.
   */
  private readonly _contentGetter: ContentGetter;

  private readonly _container: SourceContainer;

  /**
   * Hypothesized absolute path for the source. May or may not actually exist.
   */
  public readonly absolutePath: string;

  public sourceMap?: SourceLocationProvider;

  // This is the same as |_absolutePath|, but additionally checks that file exists to
  // avoid errors when page refers to non-existing paths/urls.
  private readonly _existingAbsolutePath: Promise<string | undefined>;
  private _scripts: ISourceScript[] = [];

  /**
   * Gets whether the source should be sent to the client lazily.
   * This is true for evaluated scripts. (#1939)
   */
  public get sendLazy() {
    return !this.url;
  }

  /** @internal */
  public hasBeenAnnounced = false;

  /**
   * @param inlineScriptOffset Offset of the start location of the script in
   * its source file. This is used on scripts in HTML pages, where the script
   * is nested in the content.
   * @param contentHash Optional hash of the file contents. This is used to
   * check whether the script we get is the same one as what's on disk. This
   * can be used to detect in-place transpilation.
   * @param runtimeScriptOffset Offset of the start location of the script
   * in the runtime *only*. This differs from the inlineScriptOffset, as the
   * inline offset of also reflected in the file. This is used to deal with
   * the runtime wrapping the source and offsetting locations which should
   * not be shown to the user.
   */
  constructor(
    container: SourceContainer,
    public readonly url: string,
    absolutePath: string | undefined,
    contentGetter: ContentGetter,
    sourceMapMetadata?: ISourceMapMetadata,
    public readonly inlineScriptOffset?: InlineScriptOffset,
    public readonly runtimeScriptOffset?: InlineScriptOffset,
    public readonly contentHash?: string,
  ) {
    this.sourceReference = container.getSourceReference(url);
    this._contentGetter = once(contentGetter);
    this._container = container;
    this.absolutePath = absolutePath || '';
    this._fqname = this._fullyQualifiedName();
    this._name = this._humanName();
    this.setSourceMapUrl(sourceMapMetadata);

    this._existingAbsolutePath = this.checkContentHash(contentHash);
  }

  /** Returns the absolute path if the conten hash matches. */
  protected checkContentHash(contentHash?: string) {
    return checkContentHash(
      this.absolutePath,
      // Inline scripts will never match content of the html file. We skip the content check.
      this.inlineScriptOffset || this.runtimeScriptOffset ? undefined : contentHash,
      this._container._fileContentOverridesForTest.get(this.absolutePath),
    );
  }

  /** Offsets a location that came from the runtime script, to where it appears in source code */
  public offsetScriptToSource<T extends { lineNumber: number; columnNumber: number }>(obj: T): T {
    if (this.runtimeScriptOffset) {
      return {
        ...obj,
        // Line number could go out of bounds if a location (such as a scope range)
        // refers to information in a module 'wrapper'; this happens in web extensions
        lineNumber: Math.max(1, obj.lineNumber - this.runtimeScriptOffset.lineOffset),
        columnNumber: obj.columnNumber - this.runtimeScriptOffset.columnOffset,
      };
    }

    return obj;
  }
  /** Offsets a location that came from source code, to where it appears in the runtime script */
  public offsetSourceToScript<T extends { lineNumber: number; columnNumber: number }>(obj: T): T {
    if (this.runtimeScriptOffset) {
      return {
        ...obj,
        lineNumber: obj.lineNumber + this.runtimeScriptOffset.lineOffset,
        columnNumber: obj.columnNumber + this.runtimeScriptOffset.columnOffset,
      };
    }

    return obj;
  }

  public async equalsDap(s: Dap.Source) {
    const existingAbsolutePath = await this._existingAbsolutePath;
    return existingAbsolutePath
      ? !s.sourceReference && existingAbsolutePath === s.path
      : s.sourceReference === this.sourceReference;
  }

  private setSourceMapUrl(sourceMapMetadata?: ISourceMapMetadata) {
    if (!sourceMapMetadata) {
      this.sourceMap = undefined;
      return;
    }

    this.sourceMap = {
      type: SourceLocationType.SourceMap,
      sourceByUrl: new Map(),
      value: getDeferred(),
      metadata: sourceMapMetadata,
    };
  }

  /**
   * Associated a script with this source. This is only valid for a source
   * from the runtime, not a {@link SourceFromMap}.
   */
  addScript(script: ISourceScript): void {
    this._scripts.push(script);
  }

  /**
   * Filters scripts from a source, done when an execution context is removed.
   */
  filterScripts(fn: (s: ISourceScript) => boolean): void {
    this._scripts = this._scripts.filter(fn);
  }

  /**
   * Gets scripts associated with this source.
   */
  get scripts(): ReadonlyArray<ISourceScript> {
    return this._scripts;
  }

  /**
   * Gets a suggested mimetype for the source.
   */
  get getSuggestedMimeType(): string | undefined {
    if (this.url.endsWith('.wat')) {
      return 'text/wat'; // does not seem to be any standard mime type for WAT
    }

    // only return an explicit mimetype if the file has no extension (such as
    // with node internals) or a query path. Otherwise, let the editor guess.
    if (!/\.[^/]+$/.test(this.url) || this.url.includes('?')) {
      return 'text/javascript';
    }
  }

  async content(): Promise<string | undefined> {
    let content = await this._contentGetter();

    // pad for the inline source offset, see
    // https://github.com/microsoft/vscode-js-debug/issues/736
    if (this.inlineScriptOffset?.lineOffset) {
      content = '\n'.repeat(this.inlineScriptOffset.lineOffset) + content;
    }

    return content;
  }

  /**
   * Pretty-prints the source. Generates a beauitified source map if possible
   * and it hasn't already been done, and returns the created map and created
   * ephemeral source. Returns undefined if the source can't be beautified.
   */
  public async prettyPrint(): Promise<{ map: SourceMap; source: Source } | undefined> {
    if (!this._container) {
      return undefined;
    }

    if (
      isSourceWithSourceMap(this)
      && this.sourceMap.metadata.sourceMapUrl.endsWith('-pretty.map')
    ) {
      const map = this.sourceMap.value.settledValue;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return map && { map, source: [...this.sourceMap.sourceByUrl!.values()][0] };
    }

    const content = await this.content();
    if (!content) {
      return undefined;
    }

    // Eval'd scripts have empty urls, give them a temporary one for the purpose
    // of the sourcemap. See #929
    const baseUrl = this.url || `eval://${this.sourceReference}.js`;
    const sourceMapUrl = baseUrl + '-pretty.map';
    const basename = baseUrl.split(/[\/\\]/).pop() as string;
    const fileName = basename + '-pretty.js';
    const map = await prettyPrintAsSourceMap(fileName, content, baseUrl, sourceMapUrl);
    if (!map) {
      return undefined;
    }

    // Note: this overwrites existing source map.
    this.setSourceMapUrl({
      compiledPath: this.absolutePath,
      sourceMapUrl: '',
    });
    (this.sourceMap as ISourceMapLocationProvider).value.resolve(map);

    const asCompiled = this as ISourceWithMap;
    await this._container._addSourceMapSources(asCompiled, map);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return { map, source: [...asCompiled.sourceMap.sourceByUrl.values()][0] };
  }

  /**
   * Returns a DAP representation of the source.
   * Has a side-effect of announcing the script if it has not yet been annoucned.
   */
  public async toDap(): Promise<Dap.Source> {
    const existingAbsolutePath = await this._existingAbsolutePath;
    const dap: Dap.Source = {
      name: this._name,
      path: this._fqname,
      sourceReference: this.sourceReference,
      presentationHint: this.blackboxed() ? 'deemphasize' : undefined,
      origin: this.blackboxed() ? l10n.t('Skipped by skipFiles') : undefined,
    };

    if (existingAbsolutePath) {
      dap.sourceReference = 0;
      dap.path = existingAbsolutePath;
    }

    if (!this.hasBeenAnnounced) {
      this.hasBeenAnnounced = true;
      this._container.emitLoadedSource(this);
    }

    return dap;
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
   * Gets the human-readable name of the source.
   */
  private _humanName() {
    if (utils.isAbsolute(this._fqname)) {
      for (const root of this._container.rootPaths) {
        if (isSubdirectoryOf(root, this._fqname)) {
          return forceForwardSlashes(relative(root, this._fqname));
        }
      }
    }

    return this._fqname;
  }

  /**
   * Returns a pretty name for the script. This is the name displayed in
   * stack traces and returned through DAP if the file does not verifiably
   * exist on disk.
   */
  private _fullyQualifiedName(): string {
    if (!this.url) {
      return '<eval>/VM' + this.sourceReference;
    }

    if (this.url.endsWith(sourceUtils.SourceConstants.ReplExtension)) {
      return 'repl';
    }

    if (this.url.startsWith(node15InternalsPrefix)) {
      return nodeInternalsToken + '/' + this.url.slice(node15InternalsPrefix.length);
    }

    if (this.absolutePath.startsWith(nodeInternalsToken)) {
      return this.absolutePath;
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
        return '<eval>/VM' + this.sourceReference;
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

      const searchParams = url.searchParams?.toString();
      if (searchParams) {
        tokens.push('?' + searchParams);
      }

      fqname = tokens.join('');
    } catch (e) {
      // ignored
    }

    if (fqname.endsWith('/')) {
      fqname += '(index)';
    }

    if (this.inlineScriptOffset) {
      fqname += `\uA789${this.inlineScriptOffset.lineOffset + 1}:${
        this.inlineScriptOffset.columnOffset + 1
      }`;
    }
    return fqname;
  }

  /**
   * Gets whether this script is blackboxed (part of the skipfiles).
   */
  public blackboxed(): boolean {
    return this._container.isSourceSkipped(this.url);
  }
}

export interface IWasmLocationProvider extends ISourceLocationProvider {
  type: SourceLocationType.WasmSymbols;
  value: IDeferred<IWasmSymbols>;
}
export interface ISourceScript {
  executionContextId: Cdp.Runtime.ExecutionContextId;
  scriptId: Cdp.Runtime.ScriptId;
  embedderName?: string;
  hasSourceURL: boolean;
  url: string;
}

export const enum SourceLocationType {
  SourceMap,
  WasmSymbols,
}

export interface ISourceLocationProvider {
  sourceByUrl: Map<string, SourceFromMap>;
}

export interface ISourceMapLocationProvider extends ISourceLocationProvider {
  type: SourceLocationType.SourceMap;
  /** Metadata from the source map. */
  metadata: ISourceMapMetadata;
  /** The loaded sourcemap, or undefined if loading it failed. */
  value: IDeferred<SourceMap | undefined>;
}

export type SourceLocationProvider = ISourceMapLocationProvider | IWasmLocationProvider;
export namespace SourceLocationProvider {
  /** Waits for the sourcemap or wasm symbols to be loaded. */
  export async function waitForValue(
    p: SourceLocationProvider,
  ): Promise<SourceMap | IWasmSymbols | undefined> {
    return p.value.promise;
  }

  /** Waits for the sourcemap or wasm symbols to be loaded. */
  export function waitForValueWithTimeout(
    p: SourceLocationProvider,
    timeout: number,
  ): Promise<SourceMap | IWasmSymbols | undefined> {
    if (p.type === SourceLocationType.SourceMap && p.value.settledValue) {
      return Promise.resolve(p.value.settledValue);
    }

    return Promise.race([waitForValue(p), delay(timeout) as Promise<undefined>]);
  }

  /** Waits for the location to be available before returning {@link ISourceLocationProvider.sourceByUrl} */
  export async function waitForSources(p: SourceLocationProvider) {
    await waitForValue(p);
    return p.sourceByUrl;
  }
}
/**
 * A Source that has an associated sourcemap.
 */

export interface ISourceWithMap<T extends SourceLocationProvider = SourceLocationProvider>
  extends Source
{
  sourceMap: T;
}
/**
 * A Source generated from a sourcemap. For example, a TypeScript input file
 * discovered from its compiled JavaScript code.
 */

export class SourceFromMap extends Source {
  // Sources generated from the source map are referenced by some compiled sources
  // (through a source map). This map holds the original |sourceUrl| as written in the
  // source map, which was used to produce this source for each compiled.
  public readonly compiledToSourceUrl = new Map<ISourceWithMap, string>();
}

export class WasmSource extends Source implements ISourceWithMap<IWasmLocationProvider> {
  public readonly sourceMap: IWasmLocationProvider;

  constructor(
    container: SourceContainer,
    public readonly event: Cdp.Debugger.ScriptParsedEvent,
    absolutePath: string | undefined,
  ) {
    super(
      container,
      event.url,
      absolutePath,
      () => Promise.resolve('Binary content not shown, see the decompiled WAT file'),
      undefined,
      undefined,
      undefined,
      undefined,
    );

    this.sourceMap = {
      type: SourceLocationType.WasmSymbols,
      value: getDeferred(),
      // todo: popular sourceByUrl when wasm symbols load
      sourceByUrl: new Map(),
    };
  }

  protected override checkContentHash(): Promise<string | undefined> {
    // We translate wasm to wat, so we should never use the original disk version:
    return Promise.resolve(undefined);
  }

  /** Offsets a location that came from the runtime script, to where it appears in source code. (Base 1 locations) */
  public override offsetScriptToSource<T extends { lineNumber: number; columnNumber: number }>(
    obj: T,
  ): T {
    return obj;
  }
  /** Offsets a location that came from source code, to where it appears in the runtime script.  (Base 1 locations) */
  public override offsetSourceToScript<T extends { lineNumber: number; columnNumber: number }>(
    obj: T,
  ): T {
    return obj;
  }
}

export const isSourceWithMap = (source: unknown): source is ISourceWithMap =>
  !!source && source instanceof Source && !!source.sourceMap;

export const isSourceWithSourceMap = (
  source: unknown,
): source is ISourceWithMap<ISourceMapLocationProvider> =>
  isSourceWithMap(source) && source.sourceMap.type === SourceLocationType.SourceMap;

export const isSourceWithWasm = (
  source: unknown,
): source is ISourceWithMap<IWasmLocationProvider> =>
  isSourceWithMap(source) && source.sourceMap.type === SourceLocationType.WasmSymbols;

export const isWasmSymbols = (
  source: SourceMap | IWasmSymbols | undefined,
): source is IWasmSymbols =>
  !!source && typeof (source as IWasmSymbols).getDisassembly === 'function';

export type ContentGetter = () => Promise<string | undefined>;
export type LineColumn = { lineNumber: number; columnNumber: number }; // 1-based

export function uiToRawOffset<T extends LineColumn>(lc: T, offset?: InlineScriptOffset): T {
  if (!offset) {
    return lc;
  }

  let { lineNumber, columnNumber } = lc;
  if (offset) {
    lineNumber += offset.lineOffset;
    if (lineNumber <= 1) columnNumber += offset.columnOffset;
  }

  return { ...lc, lineNumber, columnNumber };
}

export function rawToUiOffset<T extends LineColumn>(lc: T, offset?: InlineScriptOffset): T {
  if (!offset) {
    return lc;
  }

  let { lineNumber, columnNumber } = lc;
  if (offset) {
    lineNumber = Math.max(1, lineNumber - offset.lineOffset);
    if (lineNumber <= 1) columnNumber = Math.max(1, columnNumber - offset.columnOffset);
  }

  return { ...lc, lineNumber, columnNumber };
}

export const base0To1 = (lc: LineColumn) => ({
  lineNumber: lc.lineNumber + 1,
  columnNumber: lc.columnNumber + 1,
});

export const base1To0 = (lc: LineColumn) => ({
  lineNumber: lc.lineNumber - 1,
  columnNumber: lc.columnNumber - 1,
}); // This is a ui location which corresponds to a position in the document user can see (Source, Dap.Source).

/** @todo make this use IPosition's instead */
export interface IUiLocation {
  lineNumber: number; // 1-based
  columnNumber: number; // 1-based
  source: Source;
}
