// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as path from 'path';
import * as urlUtils from '../common/urlUtils';

// Mapping between urls (operated in cdp) and paths (operated in dap) is
// specific to the actual product being debugged.
export interface SourcePathResolver {
  urlToAbsolutePath(url: string): string;
  absolutePathToUrl(absolutePath: string): string | undefined;
}

// Script tags in html have line/column numbers offset relative to the actual script start.
export type InlineScriptOffset = { lineOffset: number, columnOffset: number };

export class FileSourcePathResolver implements SourcePathResolver {
  private _basePath: string | undefined;

  constructor(basePath: string | undefined) {
    this._basePath = basePath;
  }

  urlToAbsolutePath(url: string): string {
    const absolutePath = urlUtils.fileUrlToAbsolutePath(url);
    if (absolutePath)
      return absolutePath;

    if (!this._basePath)
      return '';

    const webpackPath = urlUtils.webpackUrlToPath(url, this._basePath);
    return webpackPath || '';
  }

  absolutePathToUrl(absolutePath: string): string | undefined {
    return urlUtils.absolutePathToFileUrl(path.normalize(absolutePath));
  }
}
