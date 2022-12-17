/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { xxHash32 } from 'js-xxhash';
import { FileGlobList } from '../fileGlobList';
import { readfile, stat } from '../fsUtils';
import { parseSourceMappingUrl } from '../sourceUtils';
import { absolutePathToFileUrl, completeUrl, fileUrlToAbsolutePath, isDataUri } from '../urlUtils';
import { ISourceMapMetadata } from './sourceMap';

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
   * Recursively finds all children matching the outFiles. Calls `processMap`
   * when it encounters new files, then `onProcessedMap` with the result of
   * doing so. `onProcessedMap` may be called with previously-cached data.
   *
   * Takes and can return a `state` value to make subsequent searches faster.
   */
  streamChildrenWithSourcemaps<T, R>(
    files: FileGlobList,
    processMap: (child: Required<ISourceMapMetadata>) => T | Promise<T>,
    onProcessedMap: (data: T) => R | Promise<R>,
    lastState?: unknown,
  ): Promise<{ values: R[]; state: unknown }>;

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
export const createMetadataForFile = async (
  compiledPath: string,
  fileContents?: string,
): Promise<Required<ISourceMapMetadata> | undefined> => {
  if (typeof fileContents === 'undefined') {
    fileContents = await readfile(compiledPath);
  }

  let sourceMapUrl = parseSourceMappingUrl(fileContents);
  if (!sourceMapUrl) {
    return;
  }

  const smIsDataUri = isDataUri(sourceMapUrl);
  if (!smIsDataUri) {
    sourceMapUrl = completeUrl(absolutePathToFileUrl(compiledPath), sourceMapUrl);
  }

  if (!sourceMapUrl) {
    return;
  }

  if (!sourceMapUrl.startsWith('data:') && !sourceMapUrl.startsWith('file://')) {
    return;
  }

  let cacheKey: number;
  if (smIsDataUri) {
    cacheKey = xxHash32(sourceMapUrl);
  } else {
    const stats = await stat(fileUrlToAbsolutePath(sourceMapUrl) || compiledPath);
    if (!stats) {
      return; // ENOENT, usually
    }
    cacheKey = stats.mtimeMs;
  }

  return {
    compiledPath,
    sourceMapUrl,
    cacheKey,
  };
};
