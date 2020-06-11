/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ISourceMapMetadata } from './sourceMap';
import { ISearchStrategy, createMetadataForFile } from './sourceMapRepository';
import globStream from 'glob-stream';
import { LogTag, ILogger } from '../logging';
import { forceForwardSlashes, fixDriveLetterAndSlashes } from '../pathUtils';
import { injectable, inject } from 'inversify';
import { FileGlobList } from '../fileGlobList';

/**
 * A source map repository that uses globbing to find candidate files.
 */
@injectable()
export class NodeSourceMapRepository implements ISearchStrategy {
  constructor(@inject(ILogger) private readonly logger: ILogger) {}

  /**
   * @inheritdoc
   */
  public async streamAllChildren<T>(
    files: FileGlobList,
    onChild: (child: string) => T | Promise<T>,
  ): Promise<T[]> {
    const todo: (T | Promise<T>)[] = [];

    await new Promise((resolve, reject) =>
      this.globForFiles(files)
        .on('data', (value: globStream.Entry) => todo.push(onChild(value.path)))
        .on('finish', resolve)
        .on('error', reject),
    );

    return (await Promise.all(todo)).filter((t): t is T => t !== undefined);
  }

  /**
   * @inheritdoc
   */
  public async streamChildrenWithSourcemaps<T>(
    files: FileGlobList,
    onChild: (child: Required<ISourceMapMetadata>) => T | Promise<T>,
  ): Promise<T[]> {
    const todo: (T | Promise<T | void>)[] = [];

    await new Promise((resolve, reject) =>
      this.globForFiles(files)
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

  private globForFiles(files: FileGlobList) {
    return globStream(
      [
        ...files.patterns.map(forceForwardSlashes),
        // Avoid reading asar files: electron patches in support for them, but
        // if we see an invalid one then it throws a synchronous error that
        // breaks glob. We don't care about asar's here, so just skip that:
        '!**/*.asar/**',
      ],
      {
        matchBase: true,
        cwd: files.rootPath,
      },
    );
  }
}
