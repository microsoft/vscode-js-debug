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
  constructor(
    private readonly original: BasicSourceMapConsumer,
    public readonly metadata: Readonly<ISourceMapMetadata>,
    private readonly actualRoot: string,
  ) {}

  /**
   * Gets the source filenames of the sourcemap.
   */
  public get sources() {
    return this.original.sources;
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
