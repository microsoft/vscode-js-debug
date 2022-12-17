/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable } from 'inversify';
import type * as vscodeType from 'vscode';
import { FileGlobList, IExplodedGlob } from '../fileGlobList';
import { ILogger, LogTag } from '../logging';
import { truthy } from '../objUtils';
import { NodeSearchStrategy } from './nodeSearchStrategy';
import { ISourceMapMetadata } from './sourceMap';
import { createMetadataForFile, ISearchStrategy } from './sourceMapRepository';

/**
 * A source map repository that uses VS Code's proposed search API to
 * look for candidate files.
 */
@injectable()
export class CodeSearchStrategy implements ISearchStrategy {
  private readonly nodeStrategy = new NodeSearchStrategy(this.logger);

  constructor(private readonly vscode: typeof vscodeType, private readonly logger: ILogger) {}

  public static createOrFallback(logger: ILogger) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const code: typeof import('vscode') = require('vscode');
      if (code.workspace.findTextInFiles !== undefined) {
        return new CodeSearchStrategy(code, logger);
      }
    } catch {
      // ignored -- VS won't have vscode as a viable import, fall back to the memory/node.js version
    }

    return new NodeSearchStrategy(logger);
  }

  /**
   * @inheritdoc
   */
  public async streamAllChildren<T>(
    files: FileGlobList,
    onChild: (child: string) => T | Promise<T>,
  ): Promise<T[]> {
    // see https://github.com/microsoft/vscode/issues/101889
    return this.nodeStrategy.streamAllChildren(files, onChild);
  }

  /**
   * @inheritdoc
   */
  public async streamChildrenWithSourcemaps<T, R>(
    outFiles: FileGlobList,
    onChild: (child: Required<ISourceMapMetadata>) => T | Promise<T>,
    onProcessedMap: (data: T) => R | Promise<R>,
  ) {
    const todo: Promise<R | undefined>[] = [];
    await Promise.all(
      [...outFiles.explode()].map(glob =>
        this._streamChildrenWithSourcemaps(onChild, onProcessedMap, glob, todo),
      ),
    );
    const done = await Promise.all(todo);
    return { values: done.filter(truthy), state: undefined };
  }

  private async _streamChildrenWithSourcemaps<T, R>(
    onChild: (child: Required<ISourceMapMetadata>) => T | Promise<T>,
    onProcessedMap: (data: T) => R | Promise<R>,
    glob: IExplodedGlob,
    todo: Promise<R | undefined>[],
  ) {
    await this.vscode.workspace.findTextInFiles(
      { pattern: 'sourceMappingURL', isCaseSensitive: true },
      {
        ...this.getTextSearchOptions(glob),
        previewOptions: { charsPerLine: Number.MAX_SAFE_INTEGER, matchLines: 1 },
      },
      result => {
        const text = 'text' in result ? result.text : result.preview.text;
        todo.push(
          createMetadataForFile(result.uri.fsPath, text)
            .then(parsed => parsed && onChild(parsed))
            .then(processed => processed && onProcessedMap(processed))
            .catch(error => {
              this.logger.warn(LogTag.SourceMapParsing, 'Error parsing source map', {
                error,
                file: result.uri.fsPath,
              });
              return undefined;
            }),
        );
      },
    );

    this.logger.info(LogTag.SourceMapParsing, `findTextInFiles search found ${todo.length} files`);

    // Type annotation is necessary for https://github.com/microsoft/TypeScript/issues/47144
    const results: (R | void)[] = await Promise.all(todo);
    return results.filter(truthy);
  }

  private getTextSearchOptions(glob: IExplodedGlob): vscodeType.FindTextInFilesOptions {
    return {
      include: new this.vscode.RelativePattern(this.vscode.Uri.file(glob.cwd), glob.pattern),
      exclude: glob.negations.join(','),
      useDefaultExcludes: false,
      useIgnoreFiles: false,
      useGlobalIgnoreFiles: false,
      followSymlinks: true,
      beforeContext: 0,
      afterContext: 0,
    };
  }
}
