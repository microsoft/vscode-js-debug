/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { LogTag, ILogger } from '../logging';
import { forceForwardSlashes } from '../pathUtils';
import { NodeSourceMapRepository } from './nodeSearchStrategy';
import { ISourceMapMetadata } from './sourceMap';
import { createMetadataForFile, ISearchStrategy } from './sourceMapRepository';
import { injectable } from 'inversify';
import { FileGlobList } from '../fileGlobList';

type vscode = typeof import('vscode');

/**
 * A source map repository that uses VS Code's proposed search API to
 * look for candidate files.
 */
@injectable()
export class CodeSearchStrategy implements ISearchStrategy {
  constructor(private readonly _vscode: vscode, private readonly logger: ILogger) {}

  public static createOrFallback(logger: ILogger) {
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
    return new NodeSourceMapRepository(logger);
  }

  /**
   * Returns the sourcemaps in the directory, given as an absolute path..
   */
  public async findDirectChildren(): Promise<{ [path: string]: Required<ISourceMapMetadata> }> {
    throw new Error('not implemented');
  }

  /**
   * @inheritdoc
   */
  public async streamAllChildren<T>(): Promise<T[]> {
    throw new Error('not implemented');
  }

  /**
   * @inheritdoc
   */
  public async streamChildrenWithSourcemaps<T>(
    outFiles: FileGlobList,
    onChild: (child: Required<ISourceMapMetadata>) => T | Promise<T>,
  ): Promise<T[]> {
    const todo: Promise<T | void>[] = [];

    const findTextFn = this._vscode.workspace.findTextInFiles.bind(this._vscode['workspace']);
    const relativePattern = this._vscode.RelativePattern;
    await findTextFn(
      { pattern: 'sourceMappingURL', isCaseSensitive: true },
      {
        include: new relativePattern(
          outFiles.rootPath,
          forceForwardSlashes(outFiles.patterns.filter(p => !p.startsWith('!')).join(', ')),
        ),
        exclude: outFiles.patterns
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
              this.logger.warn(LogTag.SourceMapParsing, 'Error parsing source map', {
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
