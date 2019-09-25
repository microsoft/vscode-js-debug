
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as path from 'path';
import { SourcePathResolver } from "../../common/sourcePathResolver";
import * as utils from '../../utils/urlUtils';

export class BrowserSourcePathResolver implements SourcePathResolver {
  // We map all urls under |_baseUrl| to files under |_basePath|.
  private _basePath?: string;
  private _baseUrl?: string;

  constructor(baseUrl: string | undefined, webRoot: string | undefined) {
    this._basePath = utils.platformPathToPreferredCase(webRoot ? path.normalize(webRoot) : undefined);
    this._baseUrl = baseUrl;
  }

  absolutePathToUrl(absolutePath: string): string | undefined {
    absolutePath = path.normalize(absolutePath);
    // Note: we do not check that absolutePath belongs to basePath to
    // allow source map sources reference outside of web root.
    if (!this._baseUrl || !this._basePath)
      return utils.absolutePathToFileUrl(absolutePath);
    const relative = path.relative(this._basePath, absolutePath);
    return utils.completeUrlEscapingRoot(this._baseUrl, utils.platformPathToUrlPath(relative));
  }

  urlToAbsolutePath(url: string): string {
    const absolutePath = utils.fileUrlToAbsolutePath(url);
    if (absolutePath)
      return absolutePath;

    if (!this._basePath)
      return '';

    const webpackPath = utils.webpackUrlToPath(url, this._basePath);
    if (webpackPath)
      return webpackPath;

    if (!this._baseUrl || !url.startsWith(this._baseUrl))
      return '';
    url = utils.urlPathToPlatformPath(url.substring(this._baseUrl.length));
    if (url === '' || url === '/')
      url = 'index.html';
    return path.join(this._basePath, url);
  }
}
