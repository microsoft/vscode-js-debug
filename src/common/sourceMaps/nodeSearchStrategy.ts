/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import globStream from 'glob-stream';
import { inject, injectable } from 'inversify';
import { FileGlobList } from '../fileGlobList';
import { ILogger, LogTag } from '../logging';
import { fixDriveLetterAndSlashes } from '../pathUtils';
import { ISourceMapMetadata } from './sourceMap';
import { createMetadataForFile, ISearchStrategy } from './sourceMapRepository';

/**
 * A source map repository that uses globbing to find candidate files.
 */
@injectable()
export class NodeSearchStrategy implements ISearchStrategy {
  constructor(@inject(ILogger) private readonly logger: ILogger) {}

  /**
   * @inheritdoc
   */
  public async streamAllChildren<T>(
    files: FileGlobList,
    onChild: (child: string) => T | Promise<T>,
  ): Promise<T[]> {
    const todo: (T | Promise<T>)[] = [];

    await this.globForFiles(files, value =>
      todo.push(onChild(fixDriveLetterAndSlashes(value.path))),
    );

    // Type annotation is necessary for https://github.com/microsoft/TypeScript/issues/47144
    const results: (T | void)[] = await Promise.all(todo);
    return results.filter((t): t is T => t !== undefined);
  }

  /**
   * @inheritdoc
   */
  public async streamChildrenWithSourcemaps<T>(
    files: FileGlobList,
    onChild: (child: Required<ISourceMapMetadata>) => T | Promise<T>,
  ): Promise<T[]> {
    const todo: (T | Promise<T | void>)[] = [];

    await this.globForFiles(files, value =>
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
    );

    // Type annotation is necessary for https://github.com/microsoft/TypeScript/issues/47144
    const results: (T | void)[] = await Promise.all(todo);
    return results.filter((t): t is T => t !== undefined);
  }

  private async globForFiles(files: FileGlobList, onFile: (file: globStream.Entry) => void) {
    await Promise.all(
      [...files.explode()].map(
        glob =>
          new Promise((resolve, reject) =>
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
                matchBase: true,
                cwd: glob.cwd,
              },
            )
              .on('data', onFile)
              .on('finish', resolve)
              .on('error', reject),
          ),
      ),
    );
  }
}
