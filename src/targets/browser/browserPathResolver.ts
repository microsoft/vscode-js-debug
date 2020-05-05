/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as path from 'path';
import * as utils from '../../common/urlUtils';
import * as fsUtils from '../../common/fsUtils';
import { ISourcePathResolverOptions, SourcePathResolverBase } from '../sourcePathResolver';
import { IUrlResolution } from '../../common/sourcePathResolver';
import {
  properResolve,
  fixDriveLetterAndSlashes,
  properRelative,
  isSubdirectoryOf,
} from '../../common/pathUtils';
import { PathMapping } from '../../configuration';
import { URL } from 'url';
import { SourceMap } from '../../common/sourceMaps/sourceMap';
import {
  getFullSourceEntry,
  defaultPathMappingResolver,
  getComputedSourceRoot,
} from '../../common/sourceMaps/sourceMapResolutionUtils';

interface IOptions extends ISourcePathResolverOptions {
  baseUrl?: string;
  pathMapping: PathMapping;
  clientID: string | undefined;
}

export class BrowserSourcePathResolver extends SourcePathResolverBase<IOptions> {
  absolutePathToUrl(absolutePath: string): string | undefined {
    absolutePath = path.normalize(absolutePath);
    const { baseUrl, pathMapping } = this.options;
    if (!baseUrl) {
      return utils.absolutePathToFileUrl(absolutePath);
    }

    const defaultMapping = ['/', pathMapping['/']] as const;
    const bestMatch =
      Object.entries(pathMapping)
        .sort(([, directoryA], [, directoryB]) => directoryB.length - directoryA.length)
        .find(([, directory]) => isSubdirectoryOf(directory, absolutePath)) || defaultMapping;
    if (!bestMatch) {
      return utils.absolutePathToFileUrl(absolutePath);
    }

    let urlPath = utils.platformPathToUrlPath(path.relative(bestMatch[1], absolutePath));
    const urlPrefix = bestMatch[0].replace(/\/$|^\//g, '');
    if (urlPrefix) {
      urlPath = urlPrefix + '/' + urlPath;
    }

    return utils.completeUrlEscapingRoot(baseUrl, urlPath);
  }

  async urlToAbsolutePath({ url, map }: IUrlResolution): Promise<string | undefined> {
    url = utils.removeQueryString(url);
    return map ? this.sourceMapSourceToAbsolute(url, map) : this.simpleUrlToAbsolute(url);
  }

  private async simpleUrlToAbsolute(url: string) {
    // If we have a file URL, we know it's absolute already and points
    // to a location on disk.
    if (utils.isFileUrl(url)) {
      const abs = utils.fileUrlToAbsolutePath(url);
      if (await fsUtils.exists(abs)) {
        return abs;
      }

      const net = utils.fileUrlToNetworkPath(url);
      if (await fsUtils.exists(net)) {
        return net;
      }
    }

    let pathname: string;
    try {
      const parsed = new URL(url);
      if (!parsed.pathname || parsed.pathname === '/') {
        pathname = 'index.html';
      } else {
        pathname = parsed.pathname;
      }
    } catch {
      pathname = url;
    }

    const pathParts = pathname
      .replace(/^\//, '') // Strip leading /
      .split(/[\/\\]/);
    while (pathParts.length > 0) {
      const joinedPath = '/' + pathParts.join('/');
      const clientPath = await defaultPathMappingResolver(
        joinedPath,
        this.options.pathMapping,
        this.logger,
      );
      if (clientPath && (await fsUtils.exists(clientPath))) {
        return clientPath;
      }

      pathParts.shift();
    }
  }

  private async sourceMapSourceToAbsolute(url: string, map: SourceMap) {
    if (!this.shouldResolveSourceMap(map.metadata)) {
      return undefined;
    }

    const { pathMapping } = this.options;
    const fullSourceEntry = getFullSourceEntry(map.sourceRoot, url);
    let mappedFullSourceEntry = this.sourceMapOverrides.apply(fullSourceEntry);
    if (mappedFullSourceEntry !== fullSourceEntry) {
      mappedFullSourceEntry = fixDriveLetterAndSlashes(mappedFullSourceEntry);
      // Prefixing ../ClientApp is a workaround for a bug in ASP.NET debugging in VisualStudio because the wwwroot is not properly configured
      const clientAppPath = properResolve(
        pathMapping['/'],
        '..',
        'ClientApp',
        properRelative(pathMapping['/'], mappedFullSourceEntry),
      );
      if (
        this.options.clientID === 'visualstudio' &&
        fullSourceEntry.startsWith('webpack:///') &&
        !(await fsUtils.exists(mappedFullSourceEntry)) &&
        (await fsUtils.exists(clientAppPath))
      ) {
        return clientAppPath;
      } else {
        return mappedFullSourceEntry;
      }
    }

    if (utils.isFileUrl(url)) {
      return utils.fileUrlToAbsolutePath(url);
    }

    if (!path.isAbsolute(url)) {
      return properResolve(
        await getComputedSourceRoot(
          map.sourceRoot,
          map.metadata.compiledPath,
          pathMapping,
          defaultPathMappingResolver,
          this.logger,
        ),
        url,
      );
    }

    return fixDriveLetterAndSlashes(url);
  }
}
