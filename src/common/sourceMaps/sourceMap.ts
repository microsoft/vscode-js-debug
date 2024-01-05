/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {
  allGeneratedPositionsFor,
  eachMapping,
  EachMapping,
  GeneratedMapping,
  generatedPositionFor,
  InvalidGeneratedMapping,
  InvalidOriginalMapping,
  OriginalMapping,
  originalPositionFor,
  TraceMap,
} from '@jridgewell/trace-mapping';
import { SourceNeedle } from '@jridgewell/trace-mapping/dist/types/types';
import { fixDriveLetterAndSlashes } from '../pathUtils';
import { completeUrlEscapingRoot, isDataUri } from '../urlUtils';

export interface ISourceMapMetadata {
  sourceMapUrl: string;
  cacheKey?: number | string;
  compiledPath: string;
}

export type NullableMappedPosition = InvalidOriginalMapping | OriginalMapping;
export type NullableGeneratedPosition = InvalidGeneratedMapping | GeneratedMapping;

/**
 * Wrapper for a parsed sourcemap.
 */
export class SourceMap {
  private static idCounter = 0;

  /**
   * Map of aliased source names to the names in the `original` map.
   */
  private sourceActualToOriginal = new Map<string, string>();
  private sourceOriginalToActual = new Map<string, string>();

  /**
   * Unique source map ID, used for cross-referencing.
   */
  public readonly id = SourceMap.idCounter++;

  constructor(
    private readonly original: TraceMap,
    public readonly metadata: Readonly<ISourceMapMetadata>,
    private readonly actualRoot: string,
    public readonly actualSources: ReadonlyArray<string | null>,
    public readonly hasNames: boolean,
  ) {
    if (actualSources.length !== original.sources.length) {
      throw new Error(`Expected actualSources.length === original.source.length`);
    }

    for (let i = 0; i < actualSources.length; i++) {
      const a = actualSources[i];
      const o = original.sources[i];
      if (a !== null && o !== null) {
        this.sourceActualToOriginal.set(a, o);
        this.sourceOriginalToActual.set(o, a);
      }
    }
  }

  /**
   * Gets the source filenames of the sourcemap. We preserve them out-of-bounds
   * since the source-map library does normalization that destroys certain
   * path segments.
   *
   * @see https://github.com/microsoft/vscode-js-debug/issues/479#issuecomment-634221103
   */
  public get sources() {
    return this.actualSources.slice();
  }

  /**
   * Gets the source root of the sourcemap.
   */
  public get sourceRoot() {
    // see SourceMapFactory.loadSourceMap for what's happening here
    return this.actualRoot;
  }

  /**
   * Gets the source URL computed from the compiled path and the source root.
   */
  public computedSourceUrl(sourceUrl: string) {
    return fixDriveLetterAndSlashes(
      completeUrlEscapingRoot(
        isDataUri(this.metadata.sourceMapUrl)
          ? this.metadata.compiledPath
          : this.metadata.sourceMapUrl,
        this.sourceRoot + sourceUrl,
      ),
    );
  }

  /**
   * @inheritdoc
   */
  originalPositionFor(generatedPosition: {
    line: number;
    column: number;
    bias?: 1 | -1;
  }): NullableMappedPosition {
    const mapped = originalPositionFor(this.original, generatedPosition);
    if (mapped.source) {
      mapped.source = this.sourceOriginalToActual.get(mapped.source) ?? mapped.source;
    }

    return mapped;
  }

  /**
   * @inheritdoc
   */
  generatedPositionFor(originalPosition: {
    line: number;
    column: number;
    bias?: 1 | -1;
    source: string;
  }): NullableGeneratedPosition {
    return generatedPositionFor(this.original, {
      ...originalPosition,
      source: this.sourceActualToOriginal.get(originalPosition.source) ?? originalPosition.source,
    });
  }

  /**
   * @inheritdoc
   */
  allGeneratedPositionsFor(originalPosition: SourceNeedle): GeneratedMapping[] {
    return allGeneratedPositionsFor(this.original, {
      ...originalPosition,
      source: this.sourceActualToOriginal.get(originalPosition.source) ?? originalPosition.source,
    });
  }

  /**
   * @inheritdoc
   */
  sourceContentFor(source: string): string | null {
    source = this.sourceActualToOriginal.get(source) ?? source;
    const index = this.original.sources.indexOf(source);
    return index === -1 ? null : this.original.sourcesContent?.[index] ?? null;
  }

  eachMapping(callback: (mapping: EachMapping) => void): void {
    eachMapping(this.original, callback);
  }
}
