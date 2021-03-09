/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import match from 'micromatch';
import * as path from 'path';
import { ILogger, LogTag } from '../common/logging';
import { node15InternalsPrefix } from '../common/node15Internal';
import {
  fixDriveLetter,
  fixDriveLetterAndSlashes,
  forceForwardSlashes,
  properJoin,
  properRelative,
  properResolve,
} from '../common/pathUtils';
import { ISourceMapMetadata } from '../common/sourceMaps/sourceMap';
import { ISourcePathResolver, IUrlResolution } from '../common/sourcePathResolver';
import {
  fileUrlToAbsolutePath,
  getCaseSensitivePaths,
  isAbsolute,
  isDataUri,
  isFileUrl,
  urlToRegex,
} from '../common/urlUtils';
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

  /**
   * Source map resolve locations. Processed to resolve any relative segments
   * of the path, to make `${workspaceFolder}/../foo` and the like work, since
   * micromatch doesn't have native awareness of them.
   */
  private readonly resolveLocations = this.options.resolveSourceMapLocations?.map(location => {
    location = location.replace(/\.[a-z0-9]+$/, '.*');
    const prefix = location.startsWith('!') ? '!' : '';
    const remaining = location.slice(prefix.length);
    if (isAbsolute(remaining)) {
      return prefix + properResolve(remaining);
    }

    return location;
  });

  constructor(protected readonly options: T, protected readonly logger: ILogger) {}

  /**
   * @inheritdoc
   */
  public abstract urlToAbsolutePath(request: IUrlResolution): Promise<string | undefined>;

  /**
   * @inheritdoc
   */
  public absolutePathToUrlRegexp(absolutePath: string): Promise<string | undefined> {
    const url = this.absolutePathToUrl(absolutePath);
    return Promise.resolve(url ? urlToRegex(url) : undefined);
  }

  /**
   * Gets the URL at which the absolute path is expected to exist.
   */
  protected abstract absolutePathToUrl(absolutePath: string): string | undefined;

  /**
   * Returns whether the source map should be used to resolve a local path,
   * following the `resolveSourceMapPaths`
   */
  public shouldResolveSourceMap({ sourceMapUrl, compiledPath }: ISourceMapMetadata) {
    // Node 15 started including some source-mapped internals (acorn), but
    // they don't ship source maps in the build. Never try to resolve those.
    if (compiledPath.startsWith(node15InternalsPrefix)) {
      return false;
    }

    if (!this.resolveLocations || this.resolveLocations.length === 0) {
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

    // Where the compiled path is webpack-internal, just resolve it. We have
    // no way to know where it's coming from, but this is necessary sometimes.
    // See https://github.com/microsoft/vscode-js-debug/issues/854#issuecomment-741958453
    if (sourcePath.startsWith('webpack-internal:///')) {
      return true;
    }

    // Be case insensitive for things that might be remote uris--we have no way
    // to know whether the server is case sensitive or not.
    const caseSensitive = /^[a-z]+:/i.test(sourceMapUrl) ? false : getCaseSensitivePaths();
    const processMatchInput = (value: string) => {
      value = forceForwardSlashes(value);
      // built-in 'nocase' match option applies only to operand; we need to normalize both
      return caseSensitive ? value : value.toLowerCase();
    };

    const l = match([processMatchInput(sourcePath)], this.resolveLocations.map(processMatchInput), {
      dot: true,
    });

    return l.length > 0;
  }

  /**
   * Rebases a remote path to a local one using the remote and local roots.
   * The path should should given as a filesystem path, not a URI.
   */
  public rebaseRemoteToLocal(remotePath: string) {
    if (!this.options.remoteRoot || !this.options.localRoot || !this.canMapPath(remotePath)) {
      return path.resolve(remotePath);
    }

    const relativePath = properRelative(this.options.remoteRoot, remotePath);
    if (relativePath.startsWith('..')) {
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
  public rebaseLocalToRemote(localPath: string) {
    if (!this.options.remoteRoot || !this.options.localRoot || !this.canMapPath(localPath)) {
      return localPath;
    }

    const relPath = properRelative(this.options.localRoot, localPath);
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
