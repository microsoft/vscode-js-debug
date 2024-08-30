/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { AnyMap, EncodedSourceMap, SectionedSourceMap } from '@jridgewell/trace-mapping';
import { inject, injectable } from 'inversify';
import { IResourceProvider } from '../../adapter/resourceProvider';
import Dap from '../../dap/api';
import { IRootDapApi } from '../../dap/connection';
import { sourceMapParseFailed } from '../../dap/errors';
import { MapUsingProjection } from '../datastructure/mapUsingProjection';
import { IDisposable } from '../disposable';
import { ILogger, LogTag } from '../logging';
import { truthy } from '../objUtils';
import { ISourcePathResolver } from '../sourcePathResolver';
import { fileUrlToAbsolutePath, isDataUri } from '../urlUtils';
import { ISourceMapMetadata, SourceMap } from './sourceMap';

export const ISourceMapFactory = Symbol('ISourceMapFactory');

/**
 * Factory that loads source maps injected per-session..
 */
export interface ISourceMapFactory {
  /**
   * Loads the provided source map.
   * @throws a {@link ProtocolError} if it cannot be parsed
   */
  load(metadata: ISourceMapMetadata): Promise<SourceMap>;

  /**
   * Guards a call to a source map invokation to catch parse errors. Sourcemap
   * parsing happens lazily, so we need to wrap around their call sites.
   * @see https://github.com/microsoft/vscode-js-debug/issues/483
   */
  guardSourceMapFn<T>(sourceMap: SourceMap, fn: () => T, defaultValue: () => T): T;
}

export const IRootSourceMapFactory = Symbol('IRootSourceMapFactory');

/**
 * Version of the {@link ISourceMapFactory} that's global for the session tree.
 * It caches data smartly but requires some session-specific services to be injected.
 */
export interface IRootSourceMapFactory extends IDisposable {
  load(resourceProvider: IResourceProvider, metadata: ISourceMapMetadata): Promise<SourceMap>;
  guardSourceMapFn<T>(sourceMap: SourceMap, fn: () => T, defaultValue: () => T): T;
}

@injectable()
export class SourceMapFactory implements ISourceMapFactory {
  constructor(
    @inject(IRootSourceMapFactory) private readonly root: IRootSourceMapFactory,
    @inject(IResourceProvider) private readonly resourceProvider: IResourceProvider,
  ) {}

  /** @inheritdoc */
  load(metadata: ISourceMapMetadata): Promise<SourceMap> {
    return this.root.load(this.resourceProvider, metadata);
  }

  /** @inheritdoc */
  guardSourceMapFn<T>(sourceMap: SourceMap, fn: () => T, defaultValue: () => T): T {
    return this.root.guardSourceMapFn(sourceMap, fn, defaultValue);
  }
}

interface RawExternalSection {
  offset: { line: number; column: number };
  url: string;
}

/**
 * Type of the source map before external maps.
 * @see https://sourcemaps.info/spec.html#h.535es3xeprgt
 */
export type UnresolvedSourceMap = Omit<SectionedSourceMap, 'sections'> & {
  sections: (SectionedSourceMap['sections'][0] | RawExternalSection)[];
};

/**
 * Raw source map, once external sections are resolved.
 */
export type AnySourceMap = EncodedSourceMap | SectionedSourceMap;

/**
 * Base implementation of the ISourceMapFactory.
 */
@injectable()
export class RootSourceMapFactory implements IRootSourceMapFactory {
  /**
   * A set of sourcemaps that we warned about failing to parse.
   * @see ISourceMapFactory#guardSourceMapFn
   */

  private hasWarnedAboutMaps = new WeakSet<SourceMap>();

  constructor(
    @inject(ISourcePathResolver) private readonly pathResolve: ISourcePathResolver,
    @inject(IRootDapApi) protected readonly dap: Dap.Api,
    @inject(ILogger) private readonly logger: ILogger,
  ) {}

  /**
   * @inheritdoc
   */
  public async load(
    resourceProvider: IResourceProvider,
    metadata: ISourceMapMetadata,
  ): Promise<SourceMap> {
    const basic = await this.parseSourceMap(resourceProvider, metadata.sourceMapUrl);

    // The source-map library is destructive with its sources parsing. If the
    // source root is '/', it'll "helpfully" resolve a source like `../foo.ts`
    // to `/foo.ts` as if the source map refers to the root of the filesystem.
    // This would prevent us from being able to see that it's actually in
    // a parent directory, so we make the sourceRoot empty but show it here.
    let actualRoot: string | undefined;
    if ('sourceRoot' in basic) {
      actualRoot = basic.sourceRoot;
      basic.sourceRoot = undefined;
    }

    let hasNames = false;

    // The source map library (also) "helpfully" normalizes source URLs, so
    // preserve them in the same way. Then, rename the sources to prevent any
    // of their names colliding (e.g. "webpack://./index.js" and "webpack://../index.js")
    let actualSources: (string | null)[] = [];
    if ('sections' in basic) {
      actualSources = [];
      let i = 0;
      for (const section of basic.sections) {
        const map = section.map as EncodedSourceMap;
        actualSources.push(...map.sources);
        map.sources = map.sources.map(() => `source${i++}.js`);
        hasNames ||= !!map.names?.length;
      }
    } else if ('sources' in basic && Array.isArray(basic.sources)) {
      actualSources = basic.sources;
      basic.sources = basic.sources.map((_, i) => `source${i}.js`);
      hasNames = !!basic.names?.length;
    }

    return new SourceMap(new AnyMap(basic), metadata, actualRoot ?? '', actualSources, hasNames);
  }

  private async parseSourceMap(
    resourceProvider: IResourceProvider,
    sourceMapUrl: string,
  ): Promise<AnySourceMap> {
    let sm: UnresolvedSourceMap | undefined;
    try {
      sm = await this.parseSourceMapDirect(resourceProvider, sourceMapUrl);
    } catch (e) {
      sm = await this.parsePathMappedSourceMap(resourceProvider, sourceMapUrl);
      if (!sm) {
        throw e;
      }
    }

    if ('sections' in sm) {
      const resolved = await Promise.all(
        sm.sections.map((s, i) =>
          'url' in s
            ? this.parseSourceMap(resourceProvider, s.url)
              .then(map => ({ offset: s.offset, map }))
              .catch(e => {
                this.logger.warn(LogTag.SourceMapParsing, `Error parsing nested map ${i}: ${e}`);
                return undefined;
              })
            : s
        ),
      );

      sm.sections = resolved.filter(truthy);
    }

    return sm as AnySourceMap;
  }

  private async parsePathMappedSourceMap(resourceProvider: IResourceProvider, url: string) {
    if (isDataUri(url)) {
      return;
    }

    const localSourceMapUrl = await this.pathResolve.urlToAbsolutePath({ url });
    if (!localSourceMapUrl) return;

    try {
      return this.parseSourceMapDirect(resourceProvider, localSourceMapUrl);
    } catch (error) {
      this.logger.info(LogTag.SourceMapParsing, 'Parsing path mapped source map failed.', error);
    }
  }

  /**
   * @inheritdoc
   */
  public guardSourceMapFn<T>(sourceMap: SourceMap, fn: () => T, defaultValue: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (!/error parsing/i.test(String(e.message))) {
        throw e;
      }

      if (!this.hasWarnedAboutMaps.has(sourceMap)) {
        const message = sourceMapParseFailed(sourceMap.metadata.compiledPath, e.message).error;
        this.dap.output({
          output: message.format + '\n',
          category: 'stderr',
        });
        this.hasWarnedAboutMaps.add(sourceMap);
      }

      return defaultValue();
    }
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    // no-op
  }

  private async parseSourceMapDirect(
    resourceProvider: IResourceProvider,
    sourceMapUrl: string,
  ): Promise<UnresolvedSourceMap> {
    let absolutePath = fileUrlToAbsolutePath(sourceMapUrl);
    if (absolutePath) {
      absolutePath = this.pathResolve.rebaseRemoteToLocal(absolutePath);
    }

    const content = await resourceProvider.fetch(absolutePath || sourceMapUrl);
    if (!content.ok) {
      throw content.error;
    }

    let body = content.body;
    if (body.slice(0, 3) === ')]}') {
      body = body.substring(body.indexOf('\n'));
    }

    return JSON.parse(body);
  }
}

/**
 * A cache of source maps shared between the Thread and Predictor to avoid
 * duplicate loading.
 */
@injectable()
export class CachingSourceMapFactory extends RootSourceMapFactory {
  private readonly knownMaps = new MapUsingProjection<
    string,
    {
      metadata: ISourceMapMetadata;
      reloadIfNoMtime: boolean;
      prom: Promise<SourceMap>;
    }
  >(s => s.toLowerCase());

  /**
   * @inheritdoc
   */
  public load(
    resourceProvider: IResourceProvider,
    metadata: ISourceMapMetadata,
  ): Promise<SourceMap> {
    const existing = this.knownMaps.get(metadata.sourceMapUrl);
    if (!existing) {
      return this.loadNewSourceMap(resourceProvider, metadata);
    }

    const curKey = metadata.cacheKey;
    const prevKey = existing.metadata.cacheKey;
    // If asked to reload, do so if either map is missing a mtime, or they aren't the same
    if (existing.reloadIfNoMtime) {
      if (!(curKey && prevKey && curKey === prevKey)) {
        return this.loadNewSourceMap(resourceProvider, metadata);
      } else {
        existing.reloadIfNoMtime = false;
        return existing.prom;
      }
    }

    // Otherwise, only reload if times are present and the map definitely changed.
    if (prevKey && curKey && curKey !== prevKey) {
      return this.loadNewSourceMap(resourceProvider, metadata);
    }

    return existing.prom;
  }

  private loadNewSourceMap(resourceProvider: IResourceProvider, metadata: ISourceMapMetadata) {
    const created = super.load(resourceProvider, metadata);
    this.knownMaps.set(metadata.sourceMapUrl, {
      metadata,
      reloadIfNoMtime: false,
      prom: created,
    });
    return created;
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    this.knownMaps.clear();
  }

  /**
   * Invalidates all source maps that *don't* have associated mtimes, so that
   * they're reloaded the next time they're requested.
   */
  public invalidateCache() {
    for (const map of this.knownMaps.values()) {
      map.reloadIfNoMtime = true;
    }
  }
}
