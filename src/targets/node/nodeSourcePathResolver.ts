// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as urlUtils from '../../common/urlUtils';
import * as path from 'path';
import { ISourcePathResolverOptions, SourcePathResolverBase } from '../sourcePathResolver';
import { IUrlResolution } from '../../common/sourcePathResolver';
import { properResolve } from '../../common/pathUtils';

interface IOptions extends ISourcePathResolverOptions {
  basePath?: string;
}

export class NodeSourcePathResolver extends SourcePathResolverBase<IOptions> {
  urlToAbsolutePath({ url, map }: IUrlResolution): string | undefined {
    if (map && !this.shouldResolveSourceMap(map)) {
      return undefined;
    }

    const absolutePath = urlUtils.fileUrlToAbsolutePath(url);
    if (absolutePath) {
      return this.rebaseRemoteToLocal(absolutePath);
    }

    if (!this.options.basePath) {
      return '';
    }

    const modified = this.sourceMapOverrides.apply(url);

    if (modified !== url) {
      const withBase = properResolve(this.options.basePath, modified);
      return this.rebaseRemoteToLocal(withBase);
    }
    else {
      return '';
    }
  }

  absolutePathToUrl(absolutePath: string): string | undefined {
    return urlUtils.absolutePathToFileUrl(this.rebaseLocalToRemote(path.normalize(absolutePath)));
  }
}