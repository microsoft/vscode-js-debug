/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {
  Position,
  NullableMappedPosition,
  NullablePosition,
  MappedPosition,
  MappingItem,
  BasicSourceMapConsumer,
} from 'source-map';
import { completeUrlEscapingRoot } from '../urlUtils';
import { fixDriveLetterAndSlashes } from '../pathUtils';

export interface ISourceMapMetadata {
  sourceMapUrl: string;
  mtime?: number;
  compiledPath: string;
}

/**
 * Wrapper for a parsed sourcemap.
 */
export class SourceMap implements BasicSourceMapConsumer {
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
    private readonly original: BasicSourceMapConsumer,
    public readonly metadata: Readonly<ISourceMapMetadata>,
    private readonly actualRoot: string,
    public readonly actualSources: ReadonlyArray<string>,
  ) {
    if (actualSources.length !== original.sources.length) {
      throw new Error(`Expected actualSources.length === original.source.length`);
    }

    for (let i = 0; i < actualSources.length; i++) {
      this.sourceActualToOriginal.set(actualSources[i], original.sources[i]);
      this.sourceOriginalToActual.set(original.sources[i], actualSources[i]);
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
   * Gets the optional name of the generated code that this source map is associated with
   */
  public get file() {
    return this.metadata.compiledPath ?? this.original.file;
  }

  /**
   * Gets the source root of the sourcemap.
   */
  public get sourceRoot() {
    // see SourceMapFactory.loadSourceMap for what's happening here
    return this.actualRoot;
  }

  /**
   * Gets the sources content.
   */
  public get sourcesContent() {
    return this.original.sourcesContent;
  }

  /**
   * Gets the source URL computed from the compiled path and the source root.
   */
  public computedSourceUrl(sourceUrl: string) {
    return fixDriveLetterAndSlashes(
      completeUrlEscapingRoot(
        this.metadata.sourceMapUrl.startsWith('data:')
          ? this.metadata.compiledPath
          : this.metadata.sourceMapUrl,
        this.sourceRoot + sourceUrl,
      ),
    );
  }

  /**
   * @inheritdoc
   */
  computeColumnSpans(): void {
    this.original.computeColumnSpans();
  }

  /**
   * @inheritdoc
   */
  originalPositionFor(
    generatedPosition: Position & { bias?: number | undefined },
  ): NullableMappedPosition {
    const mapped = this.original.originalPositionFor(generatedPosition);
    if (mapped.source) {
      mapped.source = this.sourceOriginalToActual.get(mapped.source) ?? mapped.source;
    }

    return mapped;
  }

  /**
   * @inheritdoc
   */
  generatedPositionFor(
    originalPosition: MappedPosition & { bias?: number | undefined },
  ): NullablePosition {
    return this.original.generatedPositionFor({
      ...originalPosition,
      source: this.sourceActualToOriginal.get(originalPosition.source) ?? originalPosition.source,
    });
  }

  /**
   * @inheritdoc
   */
  allGeneratedPositionsFor(originalPosition: MappedPosition): NullablePosition[] {
    return this.original.allGeneratedPositionsFor({
      ...originalPosition,
      source: this.sourceActualToOriginal.get(originalPosition.source) ?? originalPosition.source,
    });
  }

  /**
   * @inheritdoc
   */
  hasContentsOfAllSources(): boolean {
    return this.original.hasContentsOfAllSources();
  }

  /**
   * @inheritdoc
   */
  sourceContentFor(source: string, returnNullOnMissing?: boolean | undefined): string | null {
    return this.original.sourceContentFor(
      this.sourceActualToOriginal.get(source) ?? source,
      returnNullOnMissing,
    );
  }

  /**
   * @inheritdoc
   */
  eachMapping<ThisArg = void>(
    callback: (this: ThisArg, mapping: MappingItem) => void,
    context?: ThisArg,
    order?: number | undefined,
  ): void {
    return this.original.eachMapping(callback, context, order);
  }

  /**
   * @inheritdoc
   */
  destroy(): void {
    this.original.destroy();
  }
}
