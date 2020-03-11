/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ISourceMapMetadata, SourceMap } from './sourceMap';
import { IDisposable } from '../disposable';
import { fetch, fileUrlToAbsolutePath } from '../urlUtils';
import { LogTag, ILogger } from '../logging';
import { RawSourceMap, SourceMapConsumer, BasicSourceMapConsumer } from 'source-map';
import { injectable, inject } from 'inversify';
import { ISourcePathResolver } from '../sourcePathResolver';

export const ISourceMapFactory = Symbol('ISourceMapFactory');

/**
 * Factory that loads source maps.
 */
export interface ISourceMapFactory extends IDisposable {
  /**
   * Loads the provided source map.
   */
  load(metadata: ISourceMapMetadata): Promise<SourceMap | undefined>;
}

/**
 * A cache of source maps shared between the Thread and Predictor to avoid
 * duplicate loading.
 */
@injectable()
export class CachingSourceMapFactory implements ISourceMapFactory {
  private readonly knownMaps = new Map<string, Promise<SourceMap | undefined>>();

  constructor(
    @inject(ILogger) private readonly logger: ILogger,
    @inject(ISourcePathResolver) private readonly pathResolve: ISourcePathResolver,
  ) {}

  /**
   * Loads the provided source map.
   */
  public load(metadata: ISourceMapMetadata): Promise<SourceMap | undefined> {
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
      map.then(m => m?.destroy());
    }

    this.knownMaps.clear();
  }

  private async loadSourceMap(metadata: ISourceMapMetadata): Promise<SourceMap | undefined> {
    const basic = await this.parseSourceMap(metadata.sourceMapUrl);
    if (!basic) {
      return;
    }

    // The source-map library is destructive with its sources parsing. If the
    // source root is '/', it'll "helpfully" resolve a source like `../foo.ts`
    // to `/foo.ts` as if the source map refers to the root of the filesystem.
    // This would prevent us from being able to see that it's actually in
    // a parent directory, so we make the sourceRoot empty but show it here.
    const actualRoot = basic.sourceRoot;
    basic.sourceRoot = undefined;

    return new SourceMap(
      (await new SourceMapConsumer(basic)) as BasicSourceMapConsumer,
      metadata,
      actualRoot ?? '',
    );
  }

  private async parseSourceMap(sourceMapUrl: string): Promise<RawSourceMap | undefined> {
    let absolutePath = fileUrlToAbsolutePath(sourceMapUrl);
    if (absolutePath) {
      absolutePath = this.pathResolve.rebaseRemoteToLocal(absolutePath);
    }

    try {
      let content = await fetch(absolutePath || sourceMapUrl);
      if (content.slice(0, 3) === ')]}') {
        content = content.substring(content.indexOf('\n'));
      }

      return JSON.parse(content);
    } catch (err) {
      this.logger.warn(LogTag.SourceMapParsing, 'Error fetching sourcemap', err);
    }
  }
}
