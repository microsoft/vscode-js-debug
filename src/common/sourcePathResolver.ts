// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as path from 'path';
import * as urlUtils from '../utils/urlUtils';

// Mapping between urls (operated in cdp) and paths (operated in dap) is
// specific to the actual product being debugged.
export interface SourcePathResolver {
  urlToAbsolutePath(url: string): string;
  absolutePathToUrl(absolutePath: string): string | undefined;
}

// Script tags in html have line/column numbers offset relative to the actual script start.
export type InlineScriptOffset = { lineOffset: number, columnOffset: number };

export class FileSourcePathResolver implements SourcePathResolver {
  urlToAbsolutePath(url: string): string {
    return urlUtils.fileUrlToAbsolutePath(url) || '';
  }

  absolutePathToUrl(absolutePath: string): string | undefined {
    return urlUtils.absolutePathToFileUrl(path.normalize(absolutePath));
  }
}
