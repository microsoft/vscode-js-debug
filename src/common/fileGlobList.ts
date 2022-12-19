/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import * as path from 'path';
import { AnyLaunchConfiguration } from '../configuration';
import { forceForwardSlashes } from './pathUtils';

export interface IExplodedGlob {
  cwd: string;
  negations: string[];
  pattern: string;
}

@injectable()
export class FileGlobList {
  /**
   * Root path for the search.
   */
  public readonly rootPath: string;

  /**
   * Search patterns, relative to the rootPath.
   */
  private readonly patterns: ReadonlyArray<{ pattern: string; negated: boolean }>;

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
      this.patterns = patterns.map(p => {
        const negated = p.startsWith('!');
        return { negated, pattern: p.slice(negated ? 1 : 0) };
      });
    }
  }

  /**
   * Given a set of globs like (ignore spaces):
   * - /project/foo/** /*.js
   * - /project/../bar/** /*.js
   * - !** /node_modules/**
   *
   * It returns an array where each entry is a positive glob and the processed
   * negations that apply to that glob. Star-prefixed negations are applied to
   * every path:
   *
   * - [ /project/foo/** /*.js, [ !/project/foo/** /node_modules/** ] ]
   * - [ /bar/** /*.js, [ !/bar/** /node_modules/** ] ]
   */
  public *explode(): IterableIterator<IExplodedGlob> {
    for (let i = 0; i < this.patterns.length; i++) {
      const { negated, pattern } = this.patterns[i];
      if (negated) {
        continue;
      }

      const parts = path.resolve(this.rootPath, pattern).split(/[\\/]/g);
      const firstGlobSegment = parts.findIndex(p => p.includes('*'));
      // if including a single file, just return a glob that yields only that.
      // note, here and below we intentionally use / instead of path.sep for globs
      if (firstGlobSegment === -1) {
        yield {
          cwd: parts.slice(0, -1).join('/'),
          pattern: parts[parts.length - 1],
          negations: [],
        };
        continue;
      }

      const cwd = parts.slice(0, firstGlobSegment).join('/');
      const negations = [];

      for (let k = i + 1; k < this.patterns.length; k++) {
        const { negated, pattern } = this.patterns[k];
        if (!negated) {
          continue;
        }

        // Make **-prefixed negations apply to _all_ included folders
        if (pattern.startsWith('**')) {
          negations.push(forceForwardSlashes(pattern));
        } else {
          // otherwise just resolve relative to this cwd
          const rel = path.relative(cwd, path.resolve(this.rootPath, pattern));
          if (!rel.startsWith('..')) {
            negations.push(forceForwardSlashes(rel));
          }
        }
      }

      yield { cwd, negations, pattern: parts.slice(firstGlobSegment).join('/') };
    }
  }
}

/**
 * Wrapper around the `outFiles` for the current launch config.
 */
@injectable()
export class OutFiles extends FileGlobList {
  constructor(@inject(AnyLaunchConfiguration) { rootPath, outFiles }: AnyLaunchConfiguration) {
    super({ rootPath, patterns: outFiles });
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
