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

class Directory {
  private readonly subdirectories: Map<string, Directory> = new MapUsingProjection(
    lowerCaseInsensitivePath,
  );
  private sourceMaps?: Promise<{
    [basename: string]: ISourceMapMetadata;
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
  public async allChildren(): Promise<{ [absolutePath: string]: ISourceMapMetadata }> {
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
      subdir = new Directory(path.join(this.path, segment));
      this.subdirectories.set(segment, subdir);
    }

    return subdir.lookupInternal(parts, offset + 1);
  }

  private async readChildren() {
    const result: { [basename: string]: ISourceMapMetadata } = {};

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
            const map = await this.readMapInFile(absolutePath);
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

  private async readMapInFile(absolutePath: string): Promise<ISourceMapMetadata | undefined> {
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
    };
  }
}

/**
 * Manages the collection of sourcemaps on the disk.
 */
export class LocalSourceMapRepository {
  /**
   * Map of hex-encoded hashes to source map data.
   */
  private readonly byHash = new Map<string, ISourceMapMetadata>();

  /**
   * A mapping of absolute paths on disk to sourcemaps contained in those paths.
   */
  private readonly tree: Directory = new Directory('');

  /**
   * Returns if the repository knows about any sourceMap with the given hash.
   */
  public findByHash(hash: Buffer) {
    return this.byHash.get(hash.toString('hex'));
  }

  /**
   * Returns the sourcemaps in the directory, given as an absolute path..
   */
  public async findDirectChildren(
    absolutePath: string,
  ): Promise<{ [path: string]: ISourceMapMetadata }> {
    const dir = await this.tree.lookup(absolutePath);
    return dir.directChildren();
  }

  /**
   * Recursively finds all children of the given direcotry.
   */
  public async findAllChildren(
    absolutePath: string,
  ): Promise<{ [key: string]: ISourceMapMetadata }> {
    const dir = await this.tree.lookup(absolutePath);
    return dir.allChildren();
  }
}
