/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ISourceMapMetadata } from './sourceMap';
import { ISourceMapRepository } from './sourceMapRepository';
import { RipGrepFactory, RipGrep } from 'vscode-ripgrep-runtime';
import { NodeSourceMapRepository } from './nodeSourceMapRepository';
import { MapUsingProjection } from '../datastructure/mapUsingProjection';
import { lowerCaseInsensitivePath, completeUrl, absolutePathToFileUrl } from '../urlUtils';
import { logger } from '../logging/logger';
import { LogTag } from '../logging';
import split from 'split2';
import { join } from 'path';
import { parseSourceMappingUrl } from '../sourceUtils';
import { stat } from '../fsUtils';

/**
 * A source map repository that uses ripgrep to discover paths of source
 * maps on disk.
 */
export class RipGrepSourceMapRepository implements ISourceMapRepository {
  private queries: Map<
    string,
    Promise<{ [absolutePath: string]: Required<ISourceMapMetadata> }>
  > = new MapUsingProjection(lowerCaseInsensitivePath);

  constructor(
    private readonly rg: Promise<RipGrep>,
    private readonly fallback?: ISourceMapRepository,
  ) {}

  public static create(storageDir: string, canUseFallback = true) {
    const rg = new RipGrepFactory({ storageDir }).downloadIfNeeded();

    return new RipGrepSourceMapRepository(
      rg,
      canUseFallback ? new NodeSourceMapRepository() : undefined,
    );
  }

  /**
   * Returns the sourcemaps in the directory, given as an absolute path..
   */
  public async findDirectChildren(
    _absolutePath: string,
  ): Promise<{ [path: string]: Required<ISourceMapMetadata> }> {
    throw new Error('not implemented');
  }

  /**
   * Recursively finds all children of the given direcotry.
   */
  public async findAllChildren(
    absolutePath: string,
  ): Promise<{ [key: string]: Required<ISourceMapMetadata> }> {
    const query = this.queries.get(absolutePath);
    if (query) {
      return query;
    }

    const promise = this.queryDirectory(absolutePath);
    this.queries.set(absolutePath, promise);
    return promise;
  }

  private async queryDirectory(directory: string) {
    const output: { [absolutePath: string]: Required<ISourceMapMetadata> } = {};
    try {
      const rg = await this.rg;
      await new Promise((resolve, reject) => {
        const todo: Promise<void>[] = [];
        const child = rg.spawn(
          [
            '--no-config',
            '--hidden',
            '--case-sensitive',
            '--no-line-number',
            '--no-heading',
            '--null',
            '--no-ignore',
            '--glob',
            '**/*.js',
            '--glob',
            '!node_modules',
            'sourceMappingURL',
          ],
          { cwd: directory, stdio: 'pipe' },
        );

        let stderr = '';
        const cp = child
          .on('error', reject)
          // only error if there was some stderr output; rg will return
          // 1 if there's no matches.
          .on('exit', code =>
            code && stderr
              ? reject(new Error(`rg exited with ${code}: ${stderr}`))
              : resolve(Promise.all(todo)),
          );

        cp.stderr!.on('data', chunk => (stderr += chunk.toString()));
        cp.stdout!.pipe(split()).on('data', (line: string) => {
          const [relativePath, rawMappingUrl] = line.trim().split('\0');
          let sourceMapUrl = parseSourceMappingUrl(rawMappingUrl);
          if (!sourceMapUrl) {
            return;
          }

          const compiledPath = join(directory, relativePath);
          sourceMapUrl = completeUrl(absolutePathToFileUrl(compiledPath), sourceMapUrl);
          if (!sourceMapUrl) {
            return;
          }

          if (!sourceMapUrl.startsWith('data:') && !sourceMapUrl.startsWith('file://')) {
            return;
          }

          todo.push(
            stat(compiledPath).then(stats => {
              if (stats) {
                output[compiledPath] = {
                  compiledPath,
                  sourceMapUrl: sourceMapUrl!,
                  mtime: stats && stats.mtimeMs,
                };
              }
            }),
          );
        });
      });
    } catch (error) {
      return this.fallbackOrThrow(directory, error);
    }

    return output;
  }

  private fallbackOrThrow(directory: string, error: Error) {
    if (this.fallback) {
      logger.warn(LogTag.Internal, 'Error download ripgrep, falling back', error);
      return this.fallback.findAllChildren(directory);
    }

    logger.warn(LogTag.Internal, 'Error download ripgrep without a fallback', error);
    throw error;
  }
}
