/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import globStream from 'glob-stream';
import { inject, injectable } from 'inversify';
import { FileGlobList, IExplodedGlob } from '../fileGlobList';
import { ILogger, LogTag } from '../logging';
import { truthy } from '../objUtils';
import { fixDriveLetterAndSlashes } from '../pathUtils';
import { CacheTree } from './cacheTree';
import {
  createMetadataForFile,
  ISearchStrategy,
  ISourcemapStreamOptions,
} from './sourceMapRepository';
import { IGlobCached, TurboGlobStream } from './turboGlobStream';

type CachedType<T> = CacheTree<IGlobCached<T>>;

/**
 * A search strategy that leverages knowledge about the cache to avoid
 */
@injectable()
export class TurboSearchStrategy implements ISearchStrategy {
  constructor(@inject(ILogger) protected readonly logger: ILogger) {}

  /**
   * @inheritdoc
   */
  public async streamAllChildren<T>(
    files: FileGlobList,
    onChild: (child: string) => T | Promise<T>,
  ): Promise<T[]> {
    const todo: (T | Promise<T>)[] = [];

    await this.globForFiles(
      files,
      value => todo.push(onChild(fixDriveLetterAndSlashes(value.path))),
    );

    // Type annotation is necessary for https://github.com/microsoft/TypeScript/issues/47144
    const results: (T | void)[] = await Promise.all(todo);
    return results.filter((t): t is T => t !== undefined);
  }

  /**
   * @inheritdoc
   */
  public async streamChildrenWithSourcemaps<T, R>(opts: ISourcemapStreamOptions<T, R>) {
    const todo: (Promise<R | undefined> | R)[] = [];

    const prevState = (opts.lastState as Record<string, CachedType<T>>) || {};
    const nextState: Record<string, CachedType<T>> = {};
    await Promise.all(
      [...opts.files.explode()].map(async glob => {
        const key = JSON.stringify(glob);
        const searchState = prevState[key] || CacheTree.root();
        await this._streamChildrenWithSourcemaps(searchState, opts, todo, glob);

        const pruned = CacheTree.prune(searchState);
        if (pruned) {
          nextState[key] = pruned;
        }
      }),
    );

    this.logger.info(LogTag.SourceMapParsing, `turboGlobStream search found ${todo.length} files`);

    const done = await Promise.all(todo);
    return { values: done.filter(truthy), state: nextState };
  }

  private async _streamChildrenWithSourcemaps<T, R>(
    cache: CachedType<T>,
    opts: ISourcemapStreamOptions<T, R>,
    results: (Promise<R> | R)[],
    glob: IExplodedGlob,
  ) {
    const tgs = new TurboGlobStream<T | undefined>({
      pattern: glob.pattern,
      ignore: glob.negations,
      cwd: glob.cwd,
      cache,
      filter: opts.filter,
      fileProcessor: (file, metadata) =>
        createMetadataForFile(file, metadata).then(m => m && opts.processMap(m)),
    });

    tgs.onError(({ path, error }) => {
      this.logger.warn(LogTag.SourceMapParsing, 'Error parsing source map', {
        error,
        path,
      });
    });

    tgs.onFile(t => t && results.push(opts.onProcessedMap(t)));

    await tgs.done;
  }

  protected async globForFiles(files: FileGlobList, onFile: (file: globStream.Entry) => void) {
    await Promise.all(
      [...files.explode()].map(
        glob =>
          new Promise<void>((resolve, reject) =>
            globStream(
              [
                glob.pattern,
                // Avoid reading asar files: electron patches in support for them, but
                // if we see an invalid one then it throws a synchronous error that
                // breaks glob. We don't care about asar's here, so just skip that:
                '!**/*.asar/**',
              ],
              {
                ignore: glob.negations,
                cwd: glob.cwd,
              },
            )
              .on('data', onFile)
              .on('end', resolve)
              .on('error', reject)
          ),
      ),
    );
  }
}
