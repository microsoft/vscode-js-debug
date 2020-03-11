/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { SourceMap, ISourceMapMetadata } from './sourceMaps/sourceMap';

/**
 * Request to resolve a URL to an absolute path.
 */
export interface IUrlResolution {
  /**
   * URL being resolved.
   */
  url: string;

  /**
   * The sourcemap the URL is being resolved from, if any.
   */
  map?: SourceMap;
}

export const ISourcePathResolver = Symbol('ISourcePathResolver');

/**
 * Maps between URLs (used in CDP) and paths (used in DAP).
 */
export interface ISourcePathResolver {
  /**
   * Rebases a remote path to a local one using the remote and local roots.
   * The path should should given as a filesystem path, not a URI.
   */
  rebaseRemoteToLocal(remotePath: string): string;
  /**
   * Rebases a local path to a remote one using the remote and local roots.
   * The path should should given as a filesystem path, not a URI.
   */
  rebaseLocalToRemote(localPath: string): string;

  /**
   * Returns whether the source map should be used to resolve a local path,
   * following the `resolveSourceMapPaths`
   */
  shouldResolveSourceMap(map: ISourceMapMetadata): boolean;

  /**
   * Attempts to convert a URL received from CDP to a local file path.
   */
  urlToAbsolutePath(request: IUrlResolution): Promise<string | undefined>;

  /**
   * Attempts to convert an absolute path on disk to a URL for CDP.
   */
  absolutePathToUrl(absolutePath: string): string | undefined;
}

// Script tags in html have line/column numbers offset relative to the actual script start.
export type InlineScriptOffset = { lineOffset: number; columnOffset: number };
