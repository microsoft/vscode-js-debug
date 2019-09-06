
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as path from 'path';
import { URL } from "url";
import { SourcePathResolver } from "../../common/sourcePathResolver";
import * as utils from '../../utils/urlUtils';

export class BrowserSourcePathResolver implements SourcePathResolver {
  // We map all urls under |_baseUrl| to files under |_basePath|.
  private _basePath?: string;
  private _baseUrl?: string;
  private _rules: { urlPrefix: string, pathPrefix: string }[] = [];

  constructor(baseUrl: string | undefined, webRoot: string | undefined) {
    this._basePath = webRoot ? path.normalize(webRoot) : undefined;
    this._baseUrl = baseUrl;
    if (!this._basePath)
      return;
    const substitute = (s: string): string => {
      return s.replace(/{webRoot}/g, this._basePath!);
    };
    this._rules = [
      { urlPrefix: 'webpack:///./~/', pathPrefix: substitute('{webRoot}' + path.sep + 'node_modules' + path.sep) },
      { urlPrefix: 'webpack:///./', pathPrefix: substitute('{webRoot}' + path.sep) },
      { urlPrefix: 'webpack:///src/', pathPrefix: substitute('{webRoot}' + path.sep) },
      { urlPrefix: 'webpack:///', pathPrefix: substitute('/') },  // TODO: what would this be on Windows?
    ];
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

    try {
      const u = new URL(url);
      if (url.endsWith('#' + u.hash))
        url = url.substring(url.length - u.hash.length - 1);
      if (url.endsWith('?' + u.search))
        url = url.substring(url.length - u.search.length - 1);
    } catch (e) {
    }

    for (const rule of this._rules) {
      if (url.startsWith(rule.urlPrefix))
        return rule.pathPrefix + utils.urlPathToPlatformPath(url.substring(rule.pathPrefix.length));
    }

    if (!this._basePath || !this._baseUrl || !url.startsWith(this._baseUrl))
      return '';
    url = utils.urlPathToPlatformPath(url.substring(this._baseUrl.length));
    if (url === '' || url === '/')
      url = 'index.html';
    return path.join(this._basePath, url);
  }
}
