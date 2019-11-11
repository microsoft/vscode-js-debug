/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {
  SourceMapConsumer,
  Position,
  NullableMappedPosition,
  NullablePosition,
  MappedPosition,
  MappingItem,
  IndexedSourceMapConsumer,
} from 'source-map';

export interface ISourceMapMetadata {
  hash: Buffer;
  sourceMapUrl: string;
  compiledPath?: string;
}

/**
 * Wrapper for a parsed sourcemap.
 */
export class SourceMap implements SourceMapConsumer {
  constructor(
    private readonly original: IndexedSourceMapConsumer,
    public readonly metadata: Readonly<ISourceMapMetadata>,
  ) {}

  /**
   * Gets the source filenames of the sourcemap.
   */
  public get sources() {
    return this.original.sources;
  }

  /**
   * Returns whether this sourcemap is the same as another.
   */
  public equals(other: SourceMap) {
    return other.metadata.hash.equals(other.metadata.hash);
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
    return this.original.originalPositionFor(generatedPosition);
  }

  /**
   * @inheritdoc
   */
  generatedPositionFor(
    originalPosition: MappedPosition & { bias?: number | undefined },
  ): NullablePosition {
    return this.original.generatedPositionFor(originalPosition);
  }

  /**
   * @inheritdoc
   */
  allGeneratedPositionsFor(originalPosition: MappedPosition): NullablePosition[] {
    return this.original.allGeneratedPositionsFor(originalPosition);
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
    return this.original.sourceContentFor(source, returnNullOnMissing);
  }

  /**
   * @inheritdoc
   */
  eachMapping(
    callback: (mapping: MappingItem) => void,
    context?: any,
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
