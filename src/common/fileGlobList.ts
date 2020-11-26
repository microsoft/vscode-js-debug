/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import * as path from 'path';
import { AnyLaunchConfiguration } from '../configuration';

@injectable()
export class FileGlobList {
  /**
   * Root path for the search.
   */
  public readonly rootPath: string;

  /**
   * Search patterns, relative to the rootPath.
   */
  public readonly patterns: ReadonlyArray<string>;

  /**
   * Returns whether there are any outFiles defined.
   */
  public get empty() {
    return this.patterns.length === 0;
  }

  constructor({ rootPath, patterns }: { rootPath?: string; patterns?: ReadonlyArray<string> }) {
    if (!rootPath || !patterns) {
      this.rootPath = '';
      this.patterns = [];
    } else {
      this.rootPath = rootPath;
      this.patterns = patterns.map(p => (path.isAbsolute(p) ? path.relative(rootPath, p) : p));
    }
  }
}

/**
 * Wrapper around the `outFiles` for the current launch config.
 */
@injectable()
export class OutFiles extends FileGlobList {
  constructor(
    @inject(AnyLaunchConfiguration) { rootPath, outFiles, sourceMaps }: AnyLaunchConfiguration,
  ) {
    super({ rootPath, patterns: sourceMaps === false ? [] : outFiles });
  }
}

/**
 * Wrapper around the `vueComponentPaths` for the current launch config.
 */
@injectable()
export class VueComponentPaths extends FileGlobList {
  constructor(@inject(AnyLaunchConfiguration) cfg: AnyLaunchConfiguration) {
    super({
      rootPath: cfg.rootPath,
      patterns: 'vueComponentPaths' in cfg ? cfg.vueComponentPaths : [],
    });
  }
}
