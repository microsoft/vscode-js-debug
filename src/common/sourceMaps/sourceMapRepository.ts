/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { SourceMap } from './sourceMap';
import * as fsUtils from '../fsUtils';
import * as path from 'path';
import { getCaseSensitivePaths, absolutePathToFileUrl, completeUrl } from '../urlUtils';
import { logger } from '../logging/logger';
import { parseSourceMappingUrl, loadSourceMap } from '../sourceUtils';
import { LogTag } from '../logging';
import { IDisposable } from '../disposable';
import { mapKeys } from '../objUtils';

class Directory implements IDisposable {
  private readonly subdirectories: { [basename: string]: Directory } = {};
  private sourceMaps?: Promise<{ [basename: string]: SourceMap }>;

  constructor(private readonly path: string) {}

  /**
   * Returns a Directory for the given path.
   */
  public lookup(requestedPath: string): Directory {
    if (!getCaseSensitivePaths()) {
      requestedPath = requestedPath.toLowerCase();
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
  public async allChildren(): Promise<{ [absolutePath: string]: SourceMap }> {
    const directChildren = await this.directChildren();
    const nested = await Promise.all(Object.values(this.subdirectories).map(s => s.allChildren()));
    return Object.assign({}, directChildren, ...nested);
  }

  /**
   * @inheritdoc
   */
  public async dispose() {
    for (const directory of Object.values(this.subdirectories)) {
      directory.dispose();
    }

    if (this.sourceMaps) {
      for (const sourceMap of Object.values(await this.sourceMaps)) {
        sourceMap.destroy();
      }
    }
  }

  private lookupInternal(parts: ReadonlyArray<string>, offset: number): Directory {
    if (offset === parts.length) {
      return this;
    }

    const segment = parts[offset];
    let subdir = this.subdirectories[segment];
    if (subdir) {
      subdir = this.subdirectories[segment] = new Directory(
        parts.slice(0, offset + 1).join(path.sep),
      );
    }

    return subdir.lookupInternal(parts, offset + 1);
  }

  private async readChildren() {
    const result: { [basename: string]: SourceMap } = {};
    Promise.all(
      (await fsUtils.readdir(this.path))
        .filter(e => e !== 'node_modules' && e !== '.')
        .map(async e => {
          if (!getCaseSensitivePaths()) {
            e = e.toLowerCase();
          }

          const absolutePath = path.join(this.path, e);
          const stat = await fsUtils.stat(absolutePath);
          if (!stat) {
            return;
          }

          if (stat.isFile()) {
            const map = await this.readMapInFile(absolutePath);
            if (map) {
              result[e] = map;
            }
            return;
          }

          if (stat.isDirectory()) {
            this.subdirectories[e] = this.subdirectories[e] || new Directory(absolutePath);
            return;
          }
        }),
    );

    return result;
  }

  private async readMapInFile(absolutePath: string): Promise<SourceMap | undefined> {
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
    try {
      return await loadSourceMap({
        compiledPath: absolutePath,
        sourceMapUrl: sourceMapUrl,
      });
    } catch (err) {
      logger.warn(LogTag.SourceMapParsing, 'Error parsing source map', { sourceMapUrl, err });
    }
  }
}

/**
 * Manages the collection of sourcemaps on the disk.
 */
export class LocalSourceMapRepository implements IDisposable {
  /**
   * A mapping of absolute paths on disk to sourcemaps contained in those paths.
   */
  private readonly tree: Directory = new Directory('');

  /**
   * Returns the sourcemaps in the directory, given as an absolute path..
   */
  public async findDirectChildren(absolutePath: string): Promise<{ [path: string]: SourceMap }> {
    const dir = this.tree.lookup(absolutePath);
    return dir.directChildren();
  }

  /**
   * Recursively finds all children of the given direcotry.
   */
  public findAllChildren(absolutePath: string): Promise<{ [key: string]: SourceMap }> {
    const dir = this.tree.lookup(absolutePath);
    return dir.allChildren();
  }

  public async dispose() {
    await this.tree.dispose();
  }
}
