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

interface IOptions extends ISourcePathResolverOptions {
  basePath: string;
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

    if (!this.options.basePath) {
      return '';
    }

    const withBase = properResolve(this.options.basePath, this.sourceMapOverrides.apply(url));
    return this.rebaseRemoteToLocal(withBase);
  }

  absolutePathToUrl(absolutePath: string): string | undefined {
    return urlUtils.absolutePathToFileUrl(this.rebaseLocalToRemote(path.normalize(absolutePath)));
  }

  private async sourceMapSourceToAbsolute(url: string, map: SourceMap) {
    if (!this.shouldResolveSourceMap(map)) {
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

    if (!path.isAbsolute(url)) {
      return properResolve(
        await getComputedSourceRoot(
          map.sourceRoot,
          map.metadata.compiledPath,
          { '/': this.options.basePath },
          moduleAwarePathMappingResolver(map.metadata.compiledPath),
        ),
        url,
      );
    }

    return url;
  }
}
