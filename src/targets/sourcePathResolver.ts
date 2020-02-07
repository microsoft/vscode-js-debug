/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ISourcePathResolver, IUrlResolution } from '../common/sourcePathResolver';
import {
  fixDriveLetter,
  fixDriveLetterAndSlashes,
  forceForwardSlashes,
  properResolve,
  properRelative,
  properJoin,
} from '../common/pathUtils';
import * as path from 'path';
import {
  fileUrlToAbsolutePath,
  getCaseSensitivePaths,
  isDataUri,
  isFileUrl,
  isValidUrl,
} from '../common/urlUtils';
import { LogTag, ILogger } from '../common/logging';
import { ISourceMapMetadata } from '../common/sourceMaps/sourceMap';
import match from 'micromatch';
import { SourceMapOverrides } from './sourceMapOverrides';

export interface ISourcePathResolverOptions {
  resolveSourceMapLocations: ReadonlyArray<string> | null;
  sourceMapOverrides: { [key: string]: string };
  localRoot: string | null;
  remoteRoot: string | null;
}

export abstract class SourcePathResolverBase<T extends ISourcePathResolverOptions>
  implements ISourcePathResolver {
  protected readonly sourceMapOverrides = new SourceMapOverrides(
    this.options.sourceMapOverrides,
    this.logger,
  );
  constructor(protected readonly options: T, protected readonly logger: ILogger) {}

  public abstract urlToAbsolutePath(request: IUrlResolution): Promise<string | undefined>;

  public abstract absolutePathToUrl(absolutePath: string): string | undefined;

  /**
   * Returns whether the source map should be used to resolve a local path,
   * following the `resolveSourceMapPaths`
   */
  public shouldResolveSourceMap({ sourceMapUrl, compiledPath }: ISourceMapMetadata) {
    if (
      !this.options.resolveSourceMapLocations ||
      this.options.resolveSourceMapLocations.length === 0
    ) {
      return true;
    }

    const sourcePath =
      // If the source map refers to an absolute path, that's what we're after
      fileUrlToAbsolutePath(sourceMapUrl) ||
      // If it's a data URI, use the compiled path as a stand-in. It should
      // be quite rare that ignored files (i.e. node_modules) reference
      // source modules and vise versa.
      (isDataUri(sourceMapUrl) && compiledPath) ||
      // Fall back to the raw URL if those fail.
      sourceMapUrl;

    // Be case insensitive for remote URIs--we have no way to know
    // whether the server is case sensitive or not.
    const caseSensitive = isValidUrl(sourceMapUrl) ? false : getCaseSensitivePaths();
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

    const relativePath = properRelative(this.options.remoteRoot, remotePath);
    if (relativePath.startsWith('../')) {
      return '';
    }

    let localPath = properJoin(this.options.localRoot, relativePath);

    localPath = fixDriveLetter(localPath);
    this.logger.verbose(
      LogTag.RuntimeSourceMap,
      `Mapped remoteToLocal: ${remotePath} -> ${localPath}`,
    );
    return properResolve(localPath);
  }

  /**
   * Rebases a local path to a remote one using the remote and local roots.
   * The path should should given as a filesystem path, not a URI.
   */
  protected rebaseLocalToRemote(localPath: string) {
    if (!this.options.remoteRoot || !this.options.localRoot || !this.canMapPath(localPath)) {
      return localPath;
    }

    const relPath = properRelative(this.options.localRoot, localPath);
    if (relPath.startsWith('../')) return '';

    let remotePath = properJoin(this.options.remoteRoot, relPath);

    remotePath = fixDriveLetterAndSlashes(remotePath, /*uppercaseDriveLetter=*/ true);
    this.logger.verbose(
      LogTag.RuntimeSourceMap,
      `Mapped localToRemote: ${localPath} -> ${remotePath}`,
    );
    return remotePath;
  }

  private canMapPath(candidate: string) {
    return (
      path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate) || isFileUrl(candidate)
    );
  }
}
