/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ISourceMapMetadata, SourceMap } from '../common/sourceMaps/sourceMap';
import { loadSourceMap } from '../common/sourceUtils';
import { IDisposable } from '../common/disposable';

/**
 * A cache of source maps shared between the Thread and Predictor to avoid
 * duplicate loading.
 */
export class SourceMapCache implements IDisposable {
  private readonly loadedMaps = new Map<string, Promise<SourceMap | undefined>>();

  /**
   * Loads the provided source map.
   */
  public load(metadata: ISourceMapMetadata): Promise<SourceMap | undefined> {
    const existing = this.loadedMaps.get(metadata.sourceMapUrl);
    if (existing) {
      return existing;
    }

    const created = loadSourceMap(metadata);
    this.loadedMaps.set(metadata.sourceMapUrl, created);
    return created;
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    for (const map of this.loadedMaps.values()) {
      map.then(m => m?.destroy());
    }

    this.loadedMaps.clear();
  }
}
