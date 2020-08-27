/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import { BasicSourceMapConsumer, RawSourceMap, SourceMapConsumer } from 'source-map';
import { IResourceProvider } from '../../adapter/resourceProvider';
import { MapUsingProjection } from '../datastructure/mapUsingProjection';
import { IDisposable } from '../disposable';
import { ISourcePathResolver } from '../sourcePathResolver';
import { fileUrlToAbsolutePath } from '../urlUtils';
import { ISourceMapMetadata, SourceMap } from './sourceMap';

export const ISourceMapFactory = Symbol('ISourceMapFactory');

/**
 * Factory that loads source maps.
 */
export interface ISourceMapFactory extends IDisposable {
  /**
   * Loads the provided source map.
   * @throws a {@link ProtocolError} if it cannot be parsed
   */
  load(metadata: ISourceMapMetadata): Promise<SourceMap>;
}

/**
 * A cache of source maps shared between the Thread and Predictor to avoid
 * duplicate loading.
 */
@injectable()
export class CachingSourceMapFactory implements ISourceMapFactory {
  private readonly knownMaps = new MapUsingProjection<
    string,
    {
      metadata: ISourceMapMetadata;
      reloadIfNoMtime: boolean;
      prom: Promise<SourceMap>;
    }
  >(s => s.toLowerCase());

  /**
   * Sourcemaps who have been overwritten by newly loaded maps. We can't
   * destroy these since sessions might still references them. Once finalizers
   * are available this can be removed.
   */
  private overwrittenSourceMaps: Promise<SourceMap>[] = [];

  constructor(
    @inject(ISourcePathResolver) private readonly pathResolve: ISourcePathResolver,
    @inject(IResourceProvider) private readonly resourceProvider: IResourceProvider,
  ) {}

  /**
   * @inheritdoc
   */
  public load(metadata: ISourceMapMetadata): Promise<SourceMap> {
    const existing = this.knownMaps.get(metadata.sourceMapUrl);
    if (!existing) {
      return this.loadNewSourceMap(metadata);
    }

    const curTime = metadata.mtime;
    const prevTime = existing.metadata.mtime;
    // If asked to reload, do so if either map is missing a mtime, or they aren't the same
    if (existing.reloadIfNoMtime) {
      if (!(curTime && prevTime && curTime === prevTime)) {
        this.overwrittenSourceMaps.push(existing.prom);
        return this.loadNewSourceMap(metadata);
      } else {
        existing.reloadIfNoMtime = false;
        return existing.prom;
      }
    }

    // Otherwise, only reload if times are present and the map definitely changed.
    if (prevTime && curTime && curTime !== prevTime) {
      this.overwrittenSourceMaps.push(existing.prom);
      return this.loadNewSourceMap(metadata);
    }

    return existing.prom;
  }

  private loadNewSourceMap(metadata: ISourceMapMetadata) {
    const created = this.loadSourceMap(metadata);
    this.knownMaps.set(metadata.sourceMapUrl, { metadata, reloadIfNoMtime: false, prom: created });
    return created;
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    for (const map of this.knownMaps.values()) {
      map.prom.then(
        m => m.destroy(),
        () => undefined,
      );
    }

    for (const map of this.overwrittenSourceMaps) {
      map.then(
        m => m.destroy(),
        () => undefined,
      );
    }

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

  private async loadSourceMap(metadata: ISourceMapMetadata): Promise<SourceMap> {
    const basic = await this.parseSourceMap(metadata.sourceMapUrl);

    // The source-map library is destructive with its sources parsing. If the
    // source root is '/', it'll "helpfully" resolve a source like `../foo.ts`
    // to `/foo.ts` as if the source map refers to the root of the filesystem.
    // This would prevent us from being able to see that it's actually in
    // a parent directory, so we make the sourceRoot empty but show it here.
    const actualRoot = basic.sourceRoot;
    basic.sourceRoot = undefined;

    // The source map library (also) "helpfully" normalizes source URLs, so
    // preserve them in the same way. Then, rename the sources to prevent any
    // of their names colliding (e.g. "webpack://./index.js" and "webpack://../index.js")
    const actualSources = basic.sources;
    basic.sources = basic.sources.map((_, i) => `source${i}.js`);

    return new SourceMap(
      (await new SourceMapConsumer(basic)) as BasicSourceMapConsumer,
      metadata,
      actualRoot ?? '',
      actualSources,
    );
  }

  private async parseSourceMap(sourceMapUrl: string): Promise<RawSourceMap> {
    let absolutePath = fileUrlToAbsolutePath(sourceMapUrl);
    if (absolutePath) {
      absolutePath = this.pathResolve.rebaseRemoteToLocal(absolutePath);
    }

    const content = await this.resourceProvider.fetch(absolutePath || sourceMapUrl);
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
