import { SourceMap } from './sourceMaps/sourceMap';

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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

/**
 * Maps between URLs (used in CDP) and paths (used in DAP).
 */
export interface ISourcePathResolver {
  /**
   * Attempts to convert a URL received from CDP to a local file path.
   */
  urlToAbsolutePath(request: IUrlResolution): string | undefined;

  /**
   * Attempts to convert an absolute path on disk to a URL for CDP.
   */
  absolutePathToUrl(absolutePath: string): string | undefined;
}

// Script tags in html have line/column numbers offset relative to the actual script start.
export type InlineScriptOffset = { lineOffset: number, columnOffset: number };
