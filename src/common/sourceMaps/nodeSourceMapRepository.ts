/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ISourceMapMetadata } from './sourceMap';
import * as fsUtils from '../fsUtils';
import * as path from 'path';
import { absolutePathToFileUrl, completeUrl, lowerCaseInsensitivePath } from '../urlUtils';
import { parseSourceMappingUrl } from '../sourceUtils';
import { mapKeys } from '../objUtils';
import { splitWithDriveLetter } from '../pathUtils';
import { MapUsingProjection } from '../datastructure/mapUsingProjection';
import { ISourceMapRepository } from './sourceMapRepository';

class Directory {
  private readonly subdirectories: Map<string, Directory> = new MapUsingProjection(
    lowerCaseInsensitivePath,
  );
  private sourceMaps?: Promise<{
    [basename: string]: Required<ISourceMapMetadata>;
  }>;

  constructor(private readonly path: string) {}

  /**
   * Returns a Directory for the given path.
   */
  public async lookup(requestedPath: string): Promise<Directory> {
    const segments = splitWithDriveLetter(requestedPath);
    return this.lookupInternal(segments, 0);
  }

  /**
   * Returns the sourcemaps in this directory.
   */
  public async directChildren() {
    if (!this.sourceMaps) {
      this.sourceMaps = this.readChildren();
    }

    return mapKeys(await this.sourceMaps, key => path.join(this.path, key));
  }

  /**
   * Returns all the sourcemaps in this directory or child directories.
   */
  public async allChildren(): Promise<{ [absolutePath: string]: Required<ISourceMapMetadata> }> {
    const directChildren = await this.directChildren();
    const nested = await Promise.all([...this.subdirectories.values()].map(s => s.allChildren()));
    return Object.assign({}, directChildren, ...nested);
  }

  private lookupInternal(parts: ReadonlyArray<string>, offset: number): Directory {
    if (offset === parts.length) {
      return this;
    }

    const segment = parts[offset];
    let subdir = this.subdirectories.get(segment);
    if (!subdir) {
      subdir = new Directory(this.path.replace(/\/$|\\$/, '') + path.sep + segment);
      this.subdirectories.set(segment, subdir);
    }

    return subdir.lookupInternal(parts, offset + 1);
  }

  private async readChildren() {
    const result: { [basename: string]: Required<ISourceMapMetadata> } = {};

    let basenames: string[];
    try {
      basenames = await fsUtils.readdir(this.path);
    } catch (e) {
      return result;
    }

    await Promise.all(
      basenames
        .filter(bn => bn !== 'node_modules' && bn !== '.')
        .sort()
        .map(async bn => {
          const absolutePath = path.join(this.path, bn);
          const stat = await fsUtils.stat(absolutePath);
          if (!stat) {
            return;
          }

          if (stat.isFile()) {
            const map = await this.readMapInFile(absolutePath, stat.mtimeMs);
            if (map) {
              result[bn] = map;
            }
            return;
          }

          if (stat.isDirectory() && !this.subdirectories.has(bn)) {
            this.subdirectories.set(bn, new Directory(absolutePath));
            return;
          }
        }),
    );

    return result;
  }

  private async readMapInFile(
    absolutePath: string,
    mtime: number,
  ): Promise<Required<ISourceMapMetadata> | undefined> {
    if (path.extname(absolutePath) !== '.js') {
      return;
    }
    const content = await fsUtils.readfile(absolutePath);
    let sourceMapUrl = parseSourceMappingUrl(content);
    if (!sourceMapUrl) {
      return;
    }

    sourceMapUrl = completeUrl(absolutePathToFileUrl(absolutePath), sourceMapUrl);
    if (!sourceMapUrl) {
      return;
    }
    if (!sourceMapUrl.startsWith('data:') && !sourceMapUrl.startsWith('file://')) {
      return;
    }

    return {
      compiledPath: absolutePath,
      sourceMapUrl: sourceMapUrl,
      mtime,
    };
  }
}

/**
 * Manages the collection of sourcemaps on the disk.
 */
export class NodeSourceMapRepository implements ISourceMapRepository {
  /**
   * A mapping of absolute paths on disk to sourcemaps contained in those paths.
   */
  private readonly tree: Directory = new Directory('');

  /**
   * Returns the sourcemaps in the directory, given as an absolute path..
   */
  public async findDirectChildren(
    absolutePath: string,
  ): Promise<{ [path: string]: Required<ISourceMapMetadata> }> {
    const dir = await this.tree.lookup(absolutePath);
    return dir.directChildren();
  }

  /**
   * Recursively finds all children of the given direcotry.
   */
  public async findAllChildren(
    absolutePath: string,
  ): Promise<{ [key: string]: Required<ISourceMapMetadata> }> {
    const dir = await this.tree.lookup(absolutePath);
    return dir.allChildren();
  }
}
