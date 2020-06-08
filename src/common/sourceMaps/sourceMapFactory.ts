/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ISourceMapMetadata, SourceMap } from './sourceMap';
import { IDisposable } from '../disposable';
import { fileUrlToAbsolutePath } from '../urlUtils';
import { RawSourceMap, SourceMapConsumer, BasicSourceMapConsumer } from 'source-map';
import { injectable, inject } from 'inversify';
import { ISourcePathResolver } from '../sourcePathResolver';
import { IResourceProvider } from '../../adapter/resourceProvider';

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
  private readonly knownMaps = new Map<string, Promise<SourceMap>>();

  constructor(
    @inject(ISourcePathResolver) private readonly pathResolve: ISourcePathResolver,
    @inject(IResourceProvider) private readonly resourceProvider: IResourceProvider,
  ) {}

  /**
   * @inheritdoc
   */
  public load(metadata: ISourceMapMetadata): Promise<SourceMap> {
    const existing = this.knownMaps.get(metadata.sourceMapUrl);
    if (existing) {
      return existing;
    }

    const created = this.loadSourceMap(metadata);
    this.knownMaps.set(metadata.sourceMapUrl, created);
    return created;
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    for (const map of this.knownMaps.values()) {
      map.then(
        m => m?.destroy(),
        () => undefined,
      );
    }

    this.knownMaps.clear();
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

    let content = await this.resourceProvider.fetch(absolutePath || sourceMapUrl);
    if (content.slice(0, 3) === ')]}') {
      content = content.substring(content.indexOf('\n'));
    }

    return JSON.parse(content);
  }
}
