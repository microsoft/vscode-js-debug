/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable } from 'inversify';
import { FileGlobList, IExplodedGlob } from '../fileGlobList';
import { LogTag } from '../logging';
import { truthy } from '../objUtils';
import { CacheTree } from './cacheTree';
import { NodeSearchStrategy } from './nodeSearchStrategy';
import { ISourceMapMetadata } from './sourceMap';
import { createMetadataForFile, ISearchStrategy } from './sourceMapRepository';
import { IGlobCached, TurboGlobStream } from './turboGlobStream';

type CachedType<T> = CacheTree<IGlobCached<T>>;

/**
 * A search strategy that leverages knowledge about the cache to avoid
 */
@injectable()
export class TurboSearchStrategy extends NodeSearchStrategy implements ISearchStrategy {
  /**
   * @inheritdoc
   */
  public async streamAllChildren<T>(
    files: FileGlobList,
    onChild: (child: string) => T | Promise<T>,
  ): Promise<T[]> {
    return super.streamAllChildren(files, onChild);
  }

  /**
   * @inheritdoc
   */
  public async streamChildrenWithSourcemaps<T, R>(
    outFiles: FileGlobList,
    processChild: (child: Required<ISourceMapMetadata>) => T | Promise<T>,
    onProcessedMap: (data: T) => R,
    untypedState?: unknown,
  ) {
    const todo: (Promise<R | undefined> | R)[] = [];

    const prevState = (untypedState as Record<string, CachedType<T>>) || {};
    const nextState: Record<string, CachedType<T>> = {};
    await Promise.all(
      [...outFiles.explode()].map(async glob => {
        const key = JSON.stringify(prevState);
        const searchState = prevState[key] || CacheTree.root();
        await this._streamChildrenWithSourcemaps(
          searchState,
          processChild,
          onProcessedMap,
          todo,
          glob,
        );
        CacheTree.prune(searchState);
        nextState[key] = searchState;
      }),
    );

    this.logger.info(LogTag.SourceMapParsing, `turboGlobStream search found ${todo.length} files`);

    const done = await Promise.all(todo);
    return { values: done.filter(truthy), state: nextState };
  }

  private async _streamChildrenWithSourcemaps<T, R>(
    cache: CachedType<T>,
    processChild: (child: Required<ISourceMapMetadata>) => T | Promise<T>,
    onProcessedMap: (data: T) => R,
    results: (Promise<R> | R)[],
    glob: IExplodedGlob,
  ) {
    const tgs = new TurboGlobStream<T | undefined>({
      pattern: glob.pattern,
      ignore: glob.negations,
      cwd: glob.cwd,
      cache,
      fileProcessor: file => createMetadataForFile(file).then(m => m && processChild(m)),
    });

    tgs.onError(({ path, error }) => {
      this.logger.warn(LogTag.SourceMapParsing, 'Error parsing source map', {
        error,
        path,
      });
    });

    tgs.onFile(t => t && results.push(onProcessedMap(t)));

    await tgs.done;
  }
}
