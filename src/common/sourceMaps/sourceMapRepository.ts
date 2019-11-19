/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ISourceMapMetadata } from './sourceMap';
import * as fsUtils from '../fsUtils';
import * as path from 'path';
import {
  absolutePathToFileUrl,
  completeUrl,
  lowerCaseInsensitivePath,
  getCaseSensitivePaths,
} from '../urlUtils';
import { parseSourceMappingUrl } from '../sourceUtils';
import { mapKeys } from '../objUtils';
import { readdirSync } from 'fs';
import { isWindowsPath, fixDriveLetter } from '../pathUtils';

class Directory {
  private readonly subdirectories: { [normalizedName: string]: Directory } = {};
  private sourceMaps?: Promise<{
    [basename: string]: ISourceMapMetadata;
  }>;

  constructor(private readonly path: string) {}

  /**
   * Returns a Directory for the given path.
   */
  public lookup(requestedPath: string): Directory {
    requestedPath = lowerCaseInsensitivePath(requestedPath);

    // special case: on windows treat the drive letter "c:\" as one segment.
    if (isWindowsPath(requestedPath)) {
      requestedPath = fixDriveLetter(requestedPath, false);
      const drive = requestedPath.slice(0, 3);
      return this.lookupInternal([drive, ...requestedPath.slice(3).split(path.sep)], 0);
    }

    return this.lookupInternal(requestedPath.split(path.sep), 0);
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
    const nested = await Promise.all(Object.values(this.subdirectories).map(s => s.allChildren()));
    return Object.assign({}, directChildren, ...nested);
  }

  private lookupInternal(parts: ReadonlyArray<string>, offset: number): Directory {
    if (offset === parts.length) {
      return this;
    }

    const segment = parts[offset];
    let subdir = this.subdirectories[lowerCaseInsensitivePath(segment)];
    if (subdir) {
      // continue...
    } else if (getCaseSensitivePaths() || offset === 0) {
      // on case sensitive systems, we can take the lookup at its word that it's the right path
      subdir = this.subdirectories[segment] = new Directory(
        path.join(this.path, segment),
      );
    } else {
      // otherwise, we need to make sure it's correct
      let correctCase: string | undefined;
      try {
        const children = readdirSync(this.path);
        correctCase = children.find(c => c.toLowerCase() === segment.toLowerCase());
      } catch (e) {
        console.warn(e);
        // ignored
      }

      subdir = this.subdirectories[segment] = new Directory(
        path.join(this.path, correctCase || segment),
      );
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

          if (stat.isDirectory()) {
            this.subdirectories[lowerCaseInsensitivePath(bn)] =
              this.subdirectories[bn] || new Directory(absolutePath);
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
      sourceMapUrl: fixDriveLetter(sourceMapUrl, false),
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
    const dir = this.tree.lookup(absolutePath);
    return dir.directChildren();
  }

  /**
   * Recursively finds all children of the given direcotry.
   */
  public findAllChildren(absolutePath: string): Promise<{ [key: string]: ISourceMapMetadata }> {
    const dir = this.tree.lookup(absolutePath);
    return dir.allChildren();
  }
}
