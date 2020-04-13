/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as urlUtils from '../../common/urlUtils';
import * as path from 'path';
import { ISourcePathResolverOptions, SourcePathResolverBase } from '../sourcePathResolver';
import { IUrlResolution } from '../../common/sourcePathResolver';
import { properResolve, fixDriveLetterAndSlashes } from '../../common/pathUtils';
import { SourceMap } from '../../common/sourceMaps/sourceMap';
import {
  getComputedSourceRoot,
  moduleAwarePathMappingResolver,
  getFullSourceEntry,
} from '../../common/sourceMaps/sourceMapResolutionUtils';
import { URL } from 'url';

interface IOptions extends ISourcePathResolverOptions {
  basePath?: string;
}

export class NodeSourcePathResolver extends SourcePathResolverBase<IOptions> {
  async urlToAbsolutePath({ url, map }: IUrlResolution): Promise<string | undefined> {
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

  absolutePathToUrl(absolutePath: string): string | undefined {
    return urlUtils.absolutePathToFileUrl(this.rebaseLocalToRemote(path.normalize(absolutePath)));
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
          map.sourceRoot,
          map.metadata.compiledPath,
          { '/': this.options.basePath },
          moduleAwarePathMappingResolver(map.metadata.compiledPath),
          this.logger,
        ),
        url,
      );
    }

    return this.rebaseRemoteToLocal(url) || url;
  }
}
