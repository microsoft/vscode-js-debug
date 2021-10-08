/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as path from 'path';
import { URL } from 'url';
import { IFsUtils } from '../../common/fsUtils';
import { ILogger } from '../../common/logging';
import { fixDriveLetterAndSlashes, properResolve } from '../../common/pathUtils';
import { SourceMap } from '../../common/sourceMaps/sourceMap';
import {
  getComputedSourceRoot,
  getFullSourceEntry,
  moduleAwarePathMappingResolver,
} from '../../common/sourceMaps/sourceMapResolutionUtils';
import { IUrlResolution } from '../../common/sourcePathResolver';
import * as urlUtils from '../../common/urlUtils';
import { AnyLaunchConfiguration, AnyNodeConfiguration } from '../../configuration';
import { ILinkedBreakpointLocation } from '../../ui/linkedBreakpointLocation';
import { ISourcePathResolverOptions, SourcePathResolverBase } from '../sourcePathResolver';

interface IOptions extends ISourcePathResolverOptions {
  basePath?: string;
}

const localNodeInternalsPrefix = 'node:';

export class NodeSourcePathResolver extends SourcePathResolverBase<IOptions> {
  public static shouldWarnAboutSymlinks(config: AnyLaunchConfiguration) {
    return 'runtimeArgs' in config && !config.runtimeArgs?.includes('--preserve-symlinks');
  }

  public static getOptions(c: AnyNodeConfiguration) {
    return {
      resolveSourceMapLocations: c.resolveSourceMapLocations,
      basePath: c.cwd,
      sourceMapOverrides: c.sourceMapPathOverrides,
      remoteRoot: c.remoteRoot,
      localRoot: c.localRoot,
    };
  }

  public constructor(
    private readonly fsUtils: IFsUtils,
    public readonly linkedBp: ILinkedBreakpointLocation | undefined,
    protected readonly options: IOptions,
    protected readonly logger: ILogger,
  ) {
    super(options, logger);
  }

  /**
   * Creates a new resolver by apply the options change to the current resolver.
   */
  public derive(newOptions: Partial<IOptions>) {
    return new NodeSourcePathResolver(
      this.fsUtils,
      this.linkedBp,
      { ...this.options, ...newOptions },
      this.logger,
    );
  }

  public get resolutionOptions() {
    return this.options;
  }

  /**
   * @override
   */
  public async urlToAbsolutePath({ url, map }: IUrlResolution): Promise<string | undefined> {
    // https://github.com/microsoft/vscode-js-debug/issues/529
    url = url.replace(/\?.+/, '');

    url = this.normalizeSourceMapUrl(url);

    // Allow debugging of externally loaded Node internals
    // [ by building Node with ./configure --node-builtin-modules-path $(pwd) ]
    if (url.startsWith(localNodeInternalsPrefix) && this.options.basePath) {
      url = path.join(this.options.basePath, 'lib', url.slice(localNodeInternalsPrefix.length));
      if (!url.endsWith('.js')) {
        url += '.js';
      }

      return url;
    }

    if (map) {
      return this.sourceMapSourceToAbsolute(url, map);
    }

    const absolutePath = urlUtils.fileUrlToAbsolutePath(url);
    if (absolutePath) {
      return this.rebaseRemoteToLocal(absolutePath);
    }

    // It's possible the source might be an HTTP if using the `sourceURL`
    // attribute. If this is the case, apply a source map override if it
    // applies, otherwise just assume it's relative to the basePath.
    if (urlUtils.isValidUrl(url)) {
      const mapped = this.sourceMapOverrides.apply(url);
      url = mapped === url ? new URL(url).pathname.slice(1) : mapped;
    }
    // Node internals are given us us as relative path, for example
    // require('cluster') will import a file simply named "cluster". For these
    // paths, prefix them as internal.
    else if (!path.isAbsolute(url)) {
      return `<node_internals>/${url}`;
    }
    // Otherwise, use default overrides.
    else {
      url = this.sourceMapOverrides.apply(url);
    }

    const withBase = properResolve(this.options.basePath ?? '', url);
    return this.rebaseRemoteToLocal(withBase);
  }

  private absolutePathToUrl(absolutePath: string) {
    return urlUtils.absolutePathToFileUrl(this.rebaseLocalToRemote(path.normalize(absolutePath)));
  }

  /**
   * @override
   */
  public async absolutePathToUrlRegexp(absolutePath: string): Promise<string | undefined> {
    let realPath = absolutePath;
    try {
      realPath = await this.fsUtils.realPath(absolutePath);
    } catch {
      // ignored
    }

    if (urlUtils.comparePathsWithoutCasing(realPath, absolutePath)) {
      return urlUtils.urlToRegex(this.absolutePathToUrl(absolutePath));
    }

    this.linkedBp?.warn();

    return (
      urlUtils.urlToRegex(this.absolutePathToUrl(absolutePath)) +
      '|' +
      urlUtils.urlToRegex(this.absolutePathToUrl(realPath))
    );
  }

  private async sourceMapSourceToAbsolute(url: string, map: SourceMap) {
    if (!this.shouldResolveSourceMap(map.metadata)) {
      return undefined;
    }

    const fullSourceEntry = getFullSourceEntry(map.sourceRoot, url);
    const mappedFullSourceEntry = this.sourceMapOverrides.apply(fullSourceEntry);
    if (mappedFullSourceEntry !== fullSourceEntry) {
      return fixDriveLetterAndSlashes(mappedFullSourceEntry);
    }

    if (urlUtils.isFileUrl(url)) {
      return urlUtils.fileUrlToAbsolutePath(url);
    }

    if (!path.isAbsolute(url) && this.options.basePath) {
      url = properResolve(
        await getComputedSourceRoot(
          this.options.remoteRoot && urlUtils.isAbsolute(map.sourceRoot)
            ? this.rebaseRemoteToLocal(map.sourceRoot) || map.sourceRoot
            : map.sourceRoot,
          map.metadata.compiledPath,
          { '/': this.options.basePath },
          moduleAwarePathMappingResolver(this.fsUtils, map.metadata.compiledPath),
          this.logger,
        ),
        url,
      );
    }

    return this.rebaseRemoteToLocal(url) || url;
  }
}
