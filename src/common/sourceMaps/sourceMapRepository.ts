/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { basename } from 'path';
import { FileGlobList } from '../fileGlobList';
import { readfile } from '../fsUtils';
import { parseSourceMappingUrl } from '../sourceUtils';
import { absolutePathToFileUrl, completeUrl, isDataUri } from '../urlUtils';
import { ISourceMapMetadata } from './sourceMap';

/**
 * A copy of vscode.RelativePattern, but we can't to import 'vscode' here.
 */
export interface IRelativePattern {
  base: string;
  pattern: string;
}

export const ISearchStrategy = Symbol('ISearchStrategy');

// todo@connor4312: fallback search strategy during turbo mode's beta
export const ISearchStrategyFallback = Symbol('ISearchStrategyFallback');

export interface ISourcemapStreamOptions<T, R> {
  /** List of files to find. */
  files: FileGlobList;
  /** First search for processing source map data from disk. T must be JSON-serializable. */
  processMap: (child: Required<ISourceMapMetadata>) => T | Promise<T>;
  /** Second step to handle a processed map. `data` may have been read from cache. */
  onProcessedMap: (data: T) => R | Promise<R>;
  /**
   * Optionally filter for processed files. Only files matching this pattern
   * will have the mtime checked, and _may_ result in onProcessedMap calls.
   */
  filter?: (path: string, child?: T) => boolean;
  /** Last cache state, passing it may speed things up. */
  lastState?: unknown;
}

export interface ISearchStrategy {
  /**
   * Recursively finds all children matching the outFiles. Calls `processMap`
   * when it encounters new files, then `onProcessedMap` with the result of
   * doing so. `onProcessedMap` may be called with previously-cached data.
   *
   * Takes and can return a `state` value to make subsequent searches faster.
   */
  streamChildrenWithSourcemaps<T, R>(
    opts: ISourcemapStreamOptions<T, R>,
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
  metadata: { siblings: readonly string[]; mtime: number },
  fileContents?: string,
): Promise<Required<ISourceMapMetadata> | undefined> => {
  let sourceMapUrl;
  const compiledFileName = basename(compiledPath);
  const maybeSibling = `${compiledFileName}.map`;
  if (metadata.siblings.includes(maybeSibling)) {
    sourceMapUrl = maybeSibling;
  }
  if (!sourceMapUrl) {
    if (typeof fileContents === 'undefined') {
      fileContents = await readfile(compiledPath);
    }
    sourceMapUrl = parseSourceMappingUrl(fileContents);
  }
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

  return {
    compiledPath,
    sourceMapUrl,
    cacheKey: metadata.mtime,
  };
};
