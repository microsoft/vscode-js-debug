/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ISourceMapMetadata } from './sourceMap';
import { parseSourceMappingUrl } from '../sourceUtils';
import { completeUrl, absolutePathToFileUrl } from '../urlUtils';
import { stat, readfile } from '../fsUtils';
import { FileGlobList } from '../fileGlobList';

/**
 * A copy of vscode.RelativePattern, but we can't to import 'vscode' here.
 */
export interface IRelativePattern {
  base: string;
  pattern: string;
}

export const ISearchStrategy = Symbol('ISearchStrategy');

export interface ISearchStrategy {
  /**
   * Recursively finds all children matching the outFiles, calling `onChild`
   * when children are found and returning a promise that resolves once all
   * children have been discovered.
   */
  streamChildrenWithSourcemaps<T>(
    files: FileGlobList,
    onChild: (child: Required<ISourceMapMetadata>) => T | Promise<T>,
  ): Promise<T[]>;

  /**
   * Recursively finds all children, calling `onChild` when children are found
   * and returning promise that resolves once all children have been discovered.
   */
  streamAllChildren<T>(
    files: FileGlobList,
    onChild: (child: string) => T | Promise<T>,
  ): Promise<T[]>;
}

/**
 * Generates source map metadata from a path on disk and file contents.
 * @param compiledPath -- Absolute path of the .js file on disk
 * @param fileContents -- Read contents of the file
 */
export const createMetadataForFile = async (compiledPath: string, fileContents?: string) => {
  if (typeof fileContents === 'undefined') {
    fileContents = await readfile(compiledPath);
  }

  let sourceMapUrl = parseSourceMappingUrl(fileContents);
  if (!sourceMapUrl) {
    return;
  }

  sourceMapUrl = completeUrl(absolutePathToFileUrl(compiledPath), sourceMapUrl);
  if (!sourceMapUrl) {
    return;
  }

  if (!sourceMapUrl.startsWith('data:') && !sourceMapUrl.startsWith('file://')) {
    return;
  }

  const stats = await stat(compiledPath);
  if (!stats) {
    return;
  }

  return {
    compiledPath,
    sourceMapUrl,
    mtime: stats && stats.mtimeMs,
  };
};
