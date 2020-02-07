/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as path from 'path';
import * as utils from '../../common/urlUtils';
import * as fsUtils from '../../common/fsUtils';
import { ISourcePathResolverOptions, SourcePathResolverBase } from '../sourcePathResolver';
import { IUrlResolution } from '../../common/sourcePathResolver';
import { properResolve, fixDriveLetterAndSlashes, properRelative } from '../../common/pathUtils';
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
    const baseUrl = this.options.baseUrl;
    const webRoot = this.options.pathMapping['/'];

    absolutePath = path.normalize(absolutePath);
    // Note: we do not check that absolutePath belongs to basePath to
    // allow source map sources reference outside of web root.
    if (!baseUrl || !webRoot) return utils.absolutePathToFileUrl(absolutePath);
    const relative = path.relative(webRoot, absolutePath);
    return utils.completeUrlEscapingRoot(baseUrl, utils.platformPathToUrlPath(relative));
  }

  async urlToAbsolutePath({ url, map }: IUrlResolution): Promise<string | undefined> {
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
        url.startsWith('webpack:///') &&
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
