// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Mapping between urls (operated in cdp) and paths (operated in dap) is
// specific to the actual product being debugged.
export interface ISourcePathResolver {
  urlToAbsolutePath(url: string): string | undefined;
  absolutePathToUrl(absolutePath: string): string | undefined;
}

// Script tags in html have line/column numbers offset relative to the actual script start.
export type InlineScriptOffset = { lineOffset: number, columnOffset: number };
