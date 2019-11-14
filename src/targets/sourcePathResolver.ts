// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ISourcePathResolver, IUrlResolution } from '../common/sourcePathResolver';
import { escapeRegexSpecialChars } from '../common/stringUtils';
import {
  properJoin,
  fixDriveLetter,
  fixDriveLetterAndSlashes,
  forceForwardSlashes,
  isWindowsPath,
} from '../common/pathUtils';
import * as path from 'path';
import { isFileUrl, fileUrlToAbsolutePath, getCaseSensitivePaths } from '../common/urlUtils';
import { baseDefaults } from '../configuration';
import { logger } from '../common/logging/logger';
import { LogTag } from '../common/logging';
import { SourceMap } from '../common/sourceMaps/sourceMap';
import match from 'micromatch';

export interface ISourcePathResolverOptions {
  resolveSourceMapLocations: ReadonlyArray<string> | null;
  sourceMapOverrides: { [key: string]: string };
  localRoot: string | null;
  remoteRoot: string | null;
}

export abstract class SourcePathResolverBase<T extends ISourcePathResolverOptions>
  implements ISourcePathResolver {
  constructor(protected readonly options: T) {}

  public abstract urlToAbsolutePath(request: IUrlResolution): string | undefined;

  public abstract absolutePathToUrl(absolutePath: string): string | undefined;

  /**
   * Returns whether the source map should be used to resolve a local path,
   * following the `resolveSourceMapPaths`
   */
  protected shouldResolveSourceMap(map: SourceMap) {
    if (
      !this.options.resolveSourceMapLocations ||
      this.options.resolveSourceMapLocations.length === 0
    ) {
      return true;
    }

    const isFile = isFileUrl(map.metadata.sourceMapUrl);
    const sourcePath =
      (isFile && fileUrlToAbsolutePath(map.metadata.sourceMapUrl)) || map.metadata.sourceMapUrl;

    // Be case insensitive for remote URIs--we have no way to know
    // whether the server is case sensitive or not.
    const caseSensitive = isFileUrl ? getCaseSensitivePaths() : true;
    const processMatchInput = (value: string) => {
      value = forceForwardSlashes(value);
      // built-in 'nocase' match option applies only to operand; we need to normalize both
      return caseSensitive ? value : value.toLowerCase();
    };

    return (
      match(
        [processMatchInput(sourcePath)],
        this.options.resolveSourceMapLocations.map(processMatchInput),
        { dot: true },
      ).length > 0
    );
  }

  /**
   * Rebases a remote path to a local one using the remote and local roots.
   * The path should should given as a filesystem path, not a URI.
   */
  protected rebaseRemoteToLocal(remotePath: string) {
    if (!this.options.remoteRoot || !this.options.localRoot || !this.canMapPath(remotePath)) {
      return path.resolve(remotePath);
    }

    const relativePath = relative(this.options.remoteRoot, remotePath);
    if (relativePath.startsWith('../')) {
      return '';
    }

    let localPath = join(this.options.localRoot, relativePath);

    localPath = fixDriveLetter(localPath);
    logger.verbose(LogTag.RuntimeSourceMap, `Mapped remoteToLocal: ${remotePath} -> ${localPath}`);
    return resolve(localPath);
  }

  /**
   * Rebases a local path to a remote one using the remote and local roots.
   * The path should should given as a filesystem path, not a URI.
   */
  protected rebaseLocalToRemote(localPath: string) {
    if (!this.options.remoteRoot || !this.options.localRoot || !this.canMapPath(localPath)) {
      return localPath;
    }

    const relPath = relative(this.options.localRoot, localPath);
    if (relPath.startsWith('../')) return '';

    let remotePath = join(this.options.remoteRoot, relPath);

    remotePath = fixDriveLetterAndSlashes(remotePath, /*uppercaseDriveLetter=*/ true);
    logger.verbose(LogTag.RuntimeSourceMap, `Mapped localToRemote: ${localPath} -> ${remotePath}`);
    return remotePath;
  }

  /**
   * Applies soruce map overrides to the path. The path should should given
   * as a filesystem path, not a URI.
   */
  protected applyPathOverrides(sourcePath: string) {
    const { sourceMapOverrides = baseDefaults.sourceMapPathOverrides } = this.options;
    const forwardSlashSourcePath = sourcePath.replace(/\\/g, '/');

    // Sort the overrides by length, large to small
    const sortedOverrideKeys = Object.keys(sourceMapOverrides).sort((a, b) => b.length - a.length);

    // Iterate the key/vals, only apply the first one that matches.
    for (let leftPattern of sortedOverrideKeys) {
      const rightPattern = sourceMapOverrides[leftPattern];
      const entryStr = `"${leftPattern}": "${rightPattern}"`;

      const asterisks = leftPattern.match(/\*/g) || [];
      if (asterisks.length > 1) {
        logger.warn(
          LogTag.RuntimeSourceMap,
          `Warning: only one asterisk allowed in a sourceMapPathOverrides entry - ${entryStr}`,
        );
        continue;
      }

      const replacePatternAsterisks = rightPattern.match(/\*/g) || [];
      if (replacePatternAsterisks.length > asterisks.length) {
        logger.warn(
          LogTag.RuntimeSourceMap,
          `The right side of a sourceMapPathOverrides entry must have 0 or 1 asterisks - ${entryStr}}`,
        );
        continue;
      }

      // Does it match?
      const escapedLeftPattern = escapeRegexSpecialChars(leftPattern, '/*');
      const leftRegexSegment = escapedLeftPattern.replace(/\*/g, '(.*)').replace(/\\\\/g, '/');
      const leftRegex = new RegExp(`^${leftRegexSegment}$`, 'i');
      const overridePatternMatches = forwardSlashSourcePath.match(leftRegex);
      if (!overridePatternMatches) continue;

      // Grab the value of the wildcard from the match above, replace the wildcard in the
      // replacement pattern, and return the result.
      const wildcardValue = overridePatternMatches[1];
      let mappedPath = rightPattern.replace(/\*/g, wildcardValue);

      logger.verbose(
        LogTag.RuntimeSourceMap,
        `SourceMap: mapping ${sourcePath} => ${mappedPath}, via sourceMapPathOverrides entry - ${entryStr}`,
      );
      return properJoin(mappedPath);
    }

    return sourcePath;
  }

  private canMapPath(candidate: string) {
    return (
      path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate) || isFileUrl(candidate)
    );
  }
}

/**
 * Cross-platform path.resolve
 */
function resolve(a: string): string {
  return isWindowsPath(a) ? path.win32.resolve(a) : path.posix.resolve(a);
}

/**
 * Cross-platform path.relative
 */
function relative(a: string, b: string): string {
  return isWindowsPath(a) ? path.win32.relative(a, b) : path.posix.relative(a, b);
}

/**
 * Cross-platform path.join
 */
function join(a: string, b: string): string {
  return isWindowsPath(a) ? path.win32.join(a, b) : forceForwardSlashes(path.posix.join(a, b));
}
