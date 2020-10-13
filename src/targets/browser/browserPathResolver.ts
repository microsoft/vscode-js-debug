/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import * as path from 'path';
import { URL } from 'url';
import { IVueFileMapper, VueHandling } from '../../adapter/vueFileMapper';
import { IFsUtils } from '../../common/fsUtils';
import { ILogger } from '../../common/logging';
import {
  fixDriveLetterAndSlashes,
  isSubdirectoryOf,
  properRelative,
  properResolve,
} from '../../common/pathUtils';
import { SourceMap } from '../../common/sourceMaps/sourceMap';
import {
  defaultPathMappingResolver,
  getComputedSourceRoot,
  getFullSourceEntry,
} from '../../common/sourceMaps/sourceMapResolutionUtils';
import { IUrlResolution } from '../../common/sourcePathResolver';
import * as utils from '../../common/urlUtils';
import { PathMapping } from '../../configuration';
import { ISourcePathResolverOptions, SourcePathResolverBase } from '../sourcePathResolver';

export interface IOptions extends ISourcePathResolverOptions {
  baseUrl?: string;
  pathMapping: PathMapping;
  clientID: string | undefined;
  remoteFilePrefix: string | undefined;
}

@injectable()
export class BrowserSourcePathResolver extends SourcePathResolverBase<IOptions> {
  constructor(
    @inject(IVueFileMapper) private readonly vueMapper: IVueFileMapper,
    @inject(IFsUtils) private readonly fsUtils: IFsUtils,
    options: IOptions,
    logger: ILogger,
  ) {
    super(options, logger);
  }

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

  public async urlToAbsolutePath({ url, map }: IUrlResolution): Promise<string | undefined> {
    const queryCharacter = url.indexOf('?');

    // Workaround for vue, see https://github.com/microsoft/vscode-js-debug/issues/239
    if (queryCharacter !== -1 && url.slice(queryCharacter - 4, queryCharacter) !== '.vue') {
      url = url.slice(0, queryCharacter);
    }

    return map ? this.sourceMapSourceToAbsolute(url, map) : this.simpleUrlToAbsolute(url);
  }

  private async simpleUrlToAbsolute(url: string) {
    // Simple eval'd code will never have a valid path
    if (!url) {
      return;
    }

    // If we have a file URL, we know it's absolute already and points
    // to a location on disk.
    if (utils.isFileUrl(url)) {
      const abs = utils.fileUrlToAbsolutePath(url);
      if (await this.fsUtils.exists(abs)) {
        return abs;
      }

      const net = utils.fileUrlToNetworkPath(url);
      if (await this.fsUtils.exists(net)) {
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

      if (parsed.protocol === 'webpack-internal:') {
        return undefined;
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
      if (clientPath && (await this.fsUtils.exists(clientPath))) {
        return clientPath;
      }

      pathParts.shift();
    }
  }

  private async sourceMapSourceToAbsolute(url: string, map: SourceMap) {
    if (!this.shouldResolveSourceMap(map.metadata)) {
      return undefined;
    }

    switch (this.vueMapper.getVueHandling(url)) {
      case VueHandling.Omit:
        return undefined;
      case VueHandling.Lookup:
        const vuePath = await this.vueMapper.lookup(url);
        if (vuePath) {
          return fixDriveLetterAndSlashes(vuePath);
        }
        break;
      default:
      // fall through
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
        !(await this.fsUtils.exists(mappedFullSourceEntry)) &&
        (await this.fsUtils.exists(clientAppPath))
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
