/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ISourceMapMetadata } from './sourceMap';
import { ISourceMapRepository, createMetadataForFile } from './sourceMapRepository';
import globStream from 'glob-stream';
import { logger } from '../logging/logger';
import { LogTag } from '../logging';
import { forceForwardSlashes, fixDriveLetterAndSlashes } from '../pathUtils';

/**
 * A source map repository that uses globbing to find candidate files.
 */
export class NodeSourceMapRepository implements ISourceMapRepository {
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
  public async streamAllChildren<T>(
    patterns: ReadonlyArray<string>,
    onChild: (child: Required<ISourceMapMetadata>) => Promise<T>,
  ): Promise<T[]> {
    const todo: Promise<T | void>[] = [];

    await new Promise((resolve, reject) =>
      globStream(patterns.map(forceForwardSlashes))
        .on('data', (value: globStream.Entry) =>
          todo.push(
            createMetadataForFile(fixDriveLetterAndSlashes(value.path))
              .then(parsed => parsed && onChild(parsed))
              .catch(error =>
                logger.warn(LogTag.SourceMapParsing, 'Error parsing source map', {
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
