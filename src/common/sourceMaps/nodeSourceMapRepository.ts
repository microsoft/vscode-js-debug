/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ISourceMapMetadata } from './sourceMap';
import {
  ISourceMapRepository,
  createMetadataForFile,
  IRelativePattern,
} from './sourceMapRepository';
import globStream from 'glob-stream';
import { logger } from '../logging/logger';
import { LogTag } from '../logging';
import { resolve as pathResolve, join } from 'path';
import { forceForwardSlashes, fixDriveLetterAndSlashes } from '../pathUtils';

/**
 * A source map repository that uses globbing to find candidate files.
 */
export class NodeSourceMapRepository implements ISourceMapRepository {
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
    patterns: ReadonlyArray<IRelativePattern>,
    onChild: (child: Required<ISourceMapMetadata>) => Promise<T>,
  ): Promise<T[]> {
    const todo: Promise<T | void>[] = [];

    const absolutePatterns = [
      ...patterns.map(relativePatternToAbsolute).map(forceForwardSlashes),
      // Avoid reading asar files: electron patches in support for them, but
      // if we see an invalid one then it throws a synchronous error that
      // breaks glob. We don't care about asar's here, so just skip that:
      '!**/*.asar/**',
    ];
    await new Promise((resolve, reject) =>
      globStream(absolutePatterns, {
        matchBase: true,
        // set the root of the filesystem as the 'working directory' so that
        // patterns like "!**/foo/**" get matched.
        cwd: pathResolve(absolutePatterns[0], '/'),
      })
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

function relativePatternToAbsolute(pattern: IRelativePattern): string {
  return pattern.pattern.startsWith('!') ? pattern.pattern : join(pattern.base, pattern.pattern);
}
