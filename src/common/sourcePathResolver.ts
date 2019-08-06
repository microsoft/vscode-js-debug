// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export interface WorkspaceLocation {
  absolutePath: string;
  lineNumber: number; // 1-based
  columnNumber: number;  // 1-based
}

// Mapping between urls (operated in cdp) and paths (operated in dap) is
// specific to the actual product being debugged.
export interface SourcePathResolver {
  rewriteSourceUrl(sourceUrl: string): string;
  urlToAbsolutePath(url: string): string;
  absolutePathToUrl(absolutePath: string): string | undefined;
  shouldCheckContentHash(): boolean;
  predictResolvedLocations?(location: WorkspaceLocation): WorkspaceLocation[];
}

// Script tags in html have line/column numbers offset relative to the actual script start.
export type InlineScriptOffset = { lineOffset: number, columnOffset: number };
