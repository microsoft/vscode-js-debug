/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ISourcePathResolver } from '../common/sourcePathResolver';
import { escapeRegexSpecialChars } from '../common/stringUtils';
import {
  properJoin,
  fixDriveLetter,
  fixDriveLetterAndSlashes,
  forceForwardSlashes,
} from '../common/pathUtils';
import * as path from 'path';
import { isFileUrl } from '../common/urlUtils';

export interface ISourcePathResolverOptions {
  sourceMapOverrides: { [key: string]: string };
  localRoot: string | null;
  remoteRoot: string | null;
}

export abstract class SourcePathResolverBase<T extends ISourcePathResolverOptions>
  implements ISourcePathResolver {
  constructor(protected readonly options: T) {}

  public abstract urlToAbsolutePath(url: string): string | undefined;

  public abstract absolutePathToUrl(absolutePath: string): string | undefined;

  /**
   * Rebases a remote path to a local one using the remote and local roots.
   * The path should should given as a filesystem path, not a URI.
   */
  protected rebaseRemoteToLocal(remotePath: string) {
    if (!this.options.remoteRoot || !this.options.localRoot || !this.canMapPath(remotePath)) {
      return remotePath;
    }

    const relativePath = relative(this.options.remoteRoot, remotePath);
    if (relativePath.startsWith('../')) {
      return '';
    }

    let localPath = join(this.options.localRoot, relativePath);

    localPath = fixDriveLetter(localPath);
    // todo: #34
    // logger.log(`Mapped remoteToLocal: ${remotePath} -> ${localPath}`);
    return localPath;
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
    // todo: #34
    // logger.log(`Mapped localToRemote: ${localPath} -> ${remotePath}`);
    return remotePath;
  }

  /**
   * Applies soruce map overrides to the path. The path should should given
   * as a filesystem path, not a URI.
   */
  protected applyPathOverrides(sourcePath: string) {
    const { sourceMapOverrides } = this.options;
    const forwardSlashSourcePath = sourcePath.replace(/\\/g, '/');

    // Sort the overrides by length, large to small
    const sortedOverrideKeys = Object.keys(sourceMapOverrides).sort((a, b) => b.length - a.length);

    // Iterate the key/vals, only apply the first one that matches.
    for (let leftPattern of sortedOverrideKeys) {
      const rightPattern = sourceMapOverrides[leftPattern];
      // const entryStr = `"${leftPattern}": "${rightPattern}"`;

      const asterisks = leftPattern.match(/\*/g) || [];
      if (asterisks.length > 1) {
        // todo: #34
        // logger.log(`Warning: only one asterisk allowed in a sourceMapPathOverrides entry - ${entryStr}`);
        continue;
      }

      const replacePatternAsterisks = rightPattern.match(/\*/g) || [];
      if (replacePatternAsterisks.length > asterisks.length) {
        // todo: #34
        // logger.log(`Warning: the right side of a sourceMapPathOverrides entry must have 0 or 1 asterisks - ${entryStr}}`);
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

      // todo: #34
      // logger.log(`SourceMap: mapping ${sourcePath} => ${mappedPath}, via sourceMapPathOverrides entry - ${entryStr}`);
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
 * Cross-platform path.relative
 */
function relative(a: string, b: string): string {
  return a.match(/^[A-Za-z]:/) ? path.win32.relative(a, b) : path.posix.relative(a, b);
}

/**
 * Cross-platform path.join
 */
function join(a: string, b: string): string {
  return a.match(/^[A-Za-z]:/) ? path.win32.join(a, b) : forceForwardSlashes(path.posix.join(a, b));
}
