/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ISourceMapMetadata } from './sourceMap';
import { ISourceMapRepository, createMetadataForFile } from './sourceMapRepository';
import globStream from 'glob-stream';
import { LogTag, ILogger } from '../logging';
import { forceForwardSlashes, fixDriveLetterAndSlashes } from '../pathUtils';
import { injectable, inject } from 'inversify';

/**
 * A source map repository that uses globbing to find candidate files.
 */
@injectable()
export class NodeSourceMapRepository implements ISourceMapRepository {
  constructor(@inject(ILogger) private readonly logger: ILogger) {}

  /**
   * Returns the sourcemaps in the directory, given as an absolute path..
   */
  public async findDirectChildren(): Promise<{ [path: string]: Required<ISourceMapMetadata> }> {
    throw new Error('not implemented');
  }

  /**
   * Recursively finds all children of the given direcotry.
   */
  public async streamAllChildren<T>(
    base: string,
    patterns: ReadonlyArray<string>,
    onChild: (child: Required<ISourceMapMetadata>) => Promise<T>,
  ): Promise<T[]> {
    const todo: Promise<T | void>[] = [];

    await new Promise((resolve, reject) =>
      globStream(
        [
          ...patterns.map(forceForwardSlashes),
          // Avoid reading asar files: electron patches in support for them, but
          // if we see an invalid one then it throws a synchronous error that
          // breaks glob. We don't care about asar's here, so just skip that:
          '!**/*.asar/**',
        ],
        {
          matchBase: true,
          cwd: base,
        },
      )
        .on('data', (value: globStream.Entry) =>
          todo.push(
            createMetadataForFile(fixDriveLetterAndSlashes(value.path))
              .then(parsed => parsed && onChild(parsed))
              .catch(error =>
                this.logger.warn(LogTag.SourceMapParsing, 'Error parsing source map', {
                  error,
                  file: value.path,
                }),
              ),
          ),
        )
        .on('finish', resolve)
        .on('error', reject),
    );

    return (await Promise.all(todo)).filter((t): t is T => t !== undefined);
  }
}
