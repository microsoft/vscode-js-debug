
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as path from 'path';
import { URL } from "url";
import { SourcePathResolver } from "../../common/sourcePathResolver";
import * as utils from '../../utils/urlUtils';

export class BrowserSourcePathResolver implements SourcePathResolver {
  // We map all urls under |_baseUrl| to files under |_basePath|.
  private _basePath?: string;
  private _baseUrl?: URL;
  private _rules: { urlPrefix: string, pathPrefix: string }[] = [];

  constructor(baseUrl: URL | undefined, webRoot: string | undefined) {
    this._basePath = webRoot ? path.normalize(webRoot) : undefined;
    this._baseUrl = baseUrl;
    if (!this._basePath)
      return;
    const substitute = (s: string): string => {
      return s.replace(/{webRoot}/g, this._basePath!);
    };
    this._rules = [
      { urlPrefix: 'webpack:///./~/', pathPrefix: substitute('{webRoot}/node_modules/') },
      { urlPrefix: 'webpack:///./', pathPrefix: substitute('{webRoot}/') },
      { urlPrefix: 'webpack:///src/', pathPrefix: substitute('{webRoot}/') },
      { urlPrefix: 'webpack:///', pathPrefix: substitute('/') },
    ];
  }

  absolutePathToUrl(absolutePath: string): string | undefined {
    absolutePath = path.normalize(absolutePath);
    if (!this._baseUrl || !this._basePath || !absolutePath.startsWith(this._basePath))
      return utils.absolutePathToFileUrl(absolutePath);
    const relative = path.relative(this._basePath, absolutePath);
    try {
      return new URL(relative, this._baseUrl).toString();
    } catch (e) {
    }
  }

  urlToAbsolutePath(url: string): string {
    const absolutePath = utils.fileUrlToAbsolutePath(url);
    if (absolutePath)
      return absolutePath;

    for (const rule of this._rules) {
      if (url.startsWith(rule.urlPrefix))
        return rule.pathPrefix + url.substring(rule.pathPrefix.length);
    }

    if (!this._basePath || !this._baseUrl)
      return '';
    try {
      const u = new URL(url);
      if (u.origin !== this._baseUrl.origin)
        return '';
      const pathname = path.normalize(u.pathname);
      let basepath = path.normalize(this._baseUrl.pathname);
      if (!basepath.endsWith(path.sep))
        basepath += '/';
      if (!pathname.startsWith(basepath))
        return '';
      let relative = basepath === pathname ? '' : path.normalize(path.relative(basepath, pathname));
      if (relative === '' || relative === '/')
        relative = 'index.html';
      return path.join(this._basePath, relative);
    } catch (e) {
      return '';
    }
  }
}
