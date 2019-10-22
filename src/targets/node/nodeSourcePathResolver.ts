/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as urlUtils from '../../common/urlUtils';
import * as path from 'path';
import { ISourcePathResolverOptions, SourcePathResolverBase } from '../sourcePathResolver';

interface IOptions extends ISourcePathResolverOptions {
  basePath?: string;
}

export class NodeSourcePathResolver extends SourcePathResolverBase<IOptions> {
  urlToAbsolutePath(url: string): string {
    const absolutePath = urlUtils.fileUrlToAbsolutePath(url);
    if (absolutePath) {
      return absolutePath;
    }

    if (!this.options.basePath) {
      return '';
    }

    return path.resolve(this.options.basePath, this.applyPathOverrides(url));
  }

  absolutePathToUrl(absolutePath: string): string | undefined {
    return urlUtils.absolutePathToFileUrl(path.normalize(absolutePath));
  }
}
