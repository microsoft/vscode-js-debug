/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ISourceMapMetadata } from './sourceMap';

export interface ISourceMapRepository {
  /**
   * Returns the sourcemaps in the directory, given as an absolute path.
   */
  findDirectChildren(absolutePath: string): Promise<{ [path: string]: Required<ISourceMapMetadata> }>;

  /**
   * Recursively finds all children of the given direcotry.
   */
  findAllChildren(absolutePath: string): Promise<{ [key: string]: Required<ISourceMapMetadata> }>;
}
