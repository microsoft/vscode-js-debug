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
  isWindowsPath,
  properJoin,
  properRelative,
  properResolve,
  properSplit,
} from '../common/pathUtils';
import { ISourceMapMetadata } from '../common/sourceMaps/sourceMap';
import { ISourcePathResolver, IUrlResolution } from '../common/sourcePathResolver';
import {
  fileUrlToAbsolutePath,
  getCaseSensitivePaths,
  isAbsolute,
  isDataUri,
  isFileUrl,
} from '../common/urlUtils';
import { SourceMapOverrides } from './sourceMapOverrides';

export interface ISourcePathResolverOptions {
  workspaceFolder: string;
  resolveSourceMapLocations: ReadonlyArray<string> | null;
  sourceMapOverrides: { [key: string]: string };
  localRoot: string | null;
  remoteRoot: string | null;
}

const nullByteRe = /\x00/;

export abstract class SourcePathResolverBase<T extends ISourcePathResolverOptions>
  implements ISourcePathResolver
{
  protected readonly sourceMapOverrides = new SourceMapOverrides(
    this.options.sourceMapOverrides,
    this.logger,
  );

  /**
   * Source map resolve locations. Processed to resolve any relative segments
   * of the path, to make `${workspaceFolder}/../foo` and the like work, since
   * micromatch doesn't have native awareness of them.
   */
  private readonly resolvePatterns = this.options.resolveSourceMapLocations?.map(location => {
    const prefix = location.startsWith('!') ? '!' : '';

    // replace extensions with anything, to allow both .js and .map
    let suffix = location.slice(prefix.length).replace(/(?<!\.)\.[^./\\]+$/, '.*');
    if (!isAbsolute(suffix)) {
      return forceForwardSlashes(location);
    }

    suffix = forceForwardSlashes(properResolve(suffix));

    // replace special minimatch characters that appear in the local root (vscode#166400)
    const wfParts = properSplit(this.options.workspaceFolder);
    const suffixParts = properSplit(suffix);
    let sharedPrefixLen = 0;
    for (
      let i = 0;
      i < wfParts.length
      && i < suffixParts.length
      && suffixParts[i].toLowerCase() === wfParts[i].toLowerCase();
      i++
    ) {
      sharedPrefixLen += wfParts[i].length + 1;
    }

    suffix = suffix.slice(0, sharedPrefixLen).replace(/[\[\]\(\)\{\}\!\*]/g, '\\$&') // CodeQL [SM02383] backslashes are not present in this string
      + suffix.slice(sharedPrefixLen);

    return prefix + suffix;
  });

  constructor(protected readonly options: T, protected readonly logger: ILogger) {}

  /**
   * @inheritdoc
   */
  public abstract urlToAbsolutePath(request: IUrlResolution): Promise<string | undefined>;

  /**
   * @inheritdoc
   */
  public abstract absolutePathToUrlRegexp(
    absolutePath: string,
  ): Promise<string | undefined> | string | undefined;

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

    if (!this.resolvePatterns || this.resolvePatterns.length === 0) {
      return true;
    }

    const sourcePath =
      // If the source map refers to an absolute path, that's what we're after
      fileUrlToAbsolutePath(sourceMapUrl)
      // If it's a data URI, use the compiled path as a stand-in. It should
      // be quite rare that ignored files (i.e. node_modules) reference
      // source modules and vise versa.
      || (isDataUri(sourceMapUrl) && compiledPath)
      // Fall back to the raw URL if those fail.
      || sourceMapUrl;

    // Where the compiled path is webpack-internal, just resolve it. We have
    // no way to know where it's coming from, but this is necessary sometimes.
    // See https://github.com/microsoft/vscode-js-debug/issues/854#issuecomment-741958453
    if (sourcePath.startsWith('webpack-internal:///')) {
      return true;
    }

    // Be case insensitive for things that might be remote uris--we have no way
    // to know whether the server is case sensitive or not.
    const caseSensitive = isWindowsPath(sourceMapUrl) ? false : getCaseSensitivePaths();
    const rebased = this.rebaseRemoteToLocal(sourcePath);
    const testLocations = rebased !== sourcePath ? [sourcePath, rebased] : [sourcePath];

    const l = match(testLocations.map(forceForwardSlashes), this.resolvePatterns, {
      dot: true,
      nocase: !caseSensitive,
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

  /**
   * Normalizes a source map URL for further processing. Should be called
   * before introspecting a URL included with a sourcemap.
   */
  protected normalizeSourceMapUrl(url: string) {
    // https://github.com/microsoft/vscode-js-debug/issues/1080#issuecomment-938200168
    url = url.replace(nullByteRe, '');

    // While file paths on some systems can contain "?", this is rare (and, fun
    // fact, actually cause webpack compilation to fail.) Meanwhile, webpack
    // seems to have started adding query strings to its source URLs.
    // Except don't do this for Vue. Vue is special :(
    // https://github.com/microsoft/vscode/issues/147662#issuecomment-1108985029
    // https://github.com/microsoft/vscode-js-debug/issues/1225
    const queryStringStart = url.lastIndexOf('?');
    if (queryStringStart !== -1 && url.slice(queryStringStart - 4, queryStringStart) !== '.vue') {
      url = url.slice(0, queryStringStart);
    }

    return url;
  }

  private canMapPath(candidate: string) {
    return (
      path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate)
      || isFileUrl(candidate)
    );
  }
}
