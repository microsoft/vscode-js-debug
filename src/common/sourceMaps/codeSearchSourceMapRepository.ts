/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ISourceMapMetadata } from './sourceMap';
import { ISourceMapRepository, createMetadataForFile } from './sourceMapRepository';
import { NodeSourceMapRepository } from './nodeSourceMapRepository';
import { logger } from '../logging/logger';
import { LogTag } from '../logging';
import { forceForwardSlashes } from '../pathUtils';

type FindTextFn = typeof import('vscode')['workspace']['findTextInFiles'];

/**
 * A source map repository that uses VS Code's proposed search API to
 * look for candidate files.
 */
export class CodeSearchSourceMapRepository implements ISourceMapRepository {
  constructor(private readonly findFn: FindTextFn) {}

  public static createOrFallback() {
    /*
    todo(connor4312): disabled until https://github.com/microsoft/vscode/issues/85946
    try {
      const code: typeof import('vscode') = require('vscode');
      if (code.workspace.findTextInFiles) {
        return new CodeSearchSourceMapRepository(
          code.workspace.findTextInFiles.bind(code.workspace),
        );
      }
    } catch {
      // ignored -- VS won't have vscode as a viable import, fall back to the memory/node.js version
    }
    */
    return new NodeSourceMapRepository();
  }

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
    _base: string,
    patterns: ReadonlyArray<string>,
    onChild: (child: Required<ISourceMapMetadata>) => Promise<T>,
  ): Promise<T[]> {
    const todo: Promise<T | void>[] = [];

    // TODO@rob should be absolute patterns, see https://github.com/microsoft/vscode/issues/85722
    await this.findFn(
      { pattern: 'sourceMappingURL', isCaseSensitive: true },
      {
        // todo(connor4312): is this correct way to join globs for search?
        include: forceForwardSlashes(patterns.filter(p => !p.startsWith('!')).join(', ')),
        exclude: patterns
          .filter(p => p.startsWith('!'))
          .map(p => forceForwardSlashes(p.slice(1)))
          .join(','),
        useIgnoreFiles: false,
        useGlobalIgnoreFiles: false,
        followSymlinks: true,
        previewOptions: { charsPerLine: Number.MAX_SAFE_INTEGER, matchLines: 1 },
        beforeContext: 0,
        afterContext: 0,
      },
      result => {
        const text = 'text' in result ? result.text : result.preview.text;
        todo.push(
          createMetadataForFile(result.uri.fsPath, text)
            .then(parsed => parsed && onChild(parsed))
            .catch(error =>
              logger.warn(LogTag.SourceMapParsing, 'Error parsing source map', {
                error,
                file: result.uri.fsPath,
              }),
            ),
        );
      },
    );

    return (await Promise.all(todo)).filter((t): t is T => t !== undefined);
  }
}
