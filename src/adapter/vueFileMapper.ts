/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable, inject } from 'inversify';
import { ISearchStrategy } from '../common/sourceMaps/sourceMapRepository';
import { VueComponentPaths, FileGlobList } from '../common/fileGlobList';
import { once } from '../common/objUtils';
import { basename } from 'path';

/**
 * Regex for Vue sources. The input is something like `webpack:///foo.vue?asdf.
 * This pattern does not appear to be configurable in the Vue docs, so doing
 * ahead with 'hardcoding' it here.
 *
 * The first match group is the basename.
 *
 * @see https://cli.vuejs.org/config/#css-requiremoduleextension
 */
const vueSourceUrlRe = /^webpack:\/{3}([^/]+?\.vue)(\?[0-9a-z]*)?$/i;

/**
 * Regex for a vue generated file.
 */
const vueGeneratedRe = /^webpack:\/{3}\.\/.+\.vue\?[0-9a-z]+$/i;

export const IVueFileMapper = Symbol('IVueFileMapper');

/**
 * @see IVueFileMapper#getVueHandling
 */
export const enum VueHandling {
  /**
   * Not a Vue path, probably
   */
  Unhandled,

  /**
   * Lookup the base name on disk.
   */
  Lookup,

  /**
   * Omit it from disk mapping -- it's an unrelated generated file.
   */
  Omit,
}

export interface IVueFileMapper {
  /**
   * Attempts to look up the absolute path for a Vue file with the given basename.
   */
  lookup(sourceUrl: string): Promise<string | undefined>;

  /**
   * Gets how we should handle the given source URL.
   */
  getVueHandling(sourceUrl: string): VueHandling;
}

/**
 * Discovers Vue files in the workplace, recording a map of their basenames
 * to their absolute path.
 *
 * We do this because Vue handles their sources a little differently. For
 * each Vue file, several sourcemapped files are generated, but the 'real'
 * sourcemapped file is always at `webpack:///${basename}?${randomStr}`. So
 * we need to be able to look up from basename to absolute path. That's what
 * this mapped provides.
 */
@injectable()
export class VueFileMapper implements IVueFileMapper {
  constructor(
    @inject(VueComponentPaths) private readonly files: FileGlobList,
    @inject(ISearchStrategy) private readonly search: ISearchStrategy,
  ) {}

  private readonly getMapping = once(async () => {
    const basenameToPath = new Map<string, string>();
    await this.search.streamAllChildren(this.files, file =>
      basenameToPath.set(basename(file), file),
    );

    return basenameToPath;
  });

  /**
   * @inheritdoc
   */
  public async lookup(sourceUrl: string) {
    const match = vueSourceUrlRe.exec(sourceUrl);
    if (!match) {
      return undefined;
    }

    const basenameToPath = await this.getMapping();
    return basenameToPath.get(match[1]);
  }

  /**
   * @inheritdoc
   */
  public getVueHandling(sourceUrl: string) {
    if (this.files.empty) {
      return VueHandling.Unhandled;
    }

    return vueSourceUrlRe.test(sourceUrl)
      ? VueHandling.Lookup
      : vueGeneratedRe.test(sourceUrl)
      ? VueHandling.Omit
      : VueHandling.Unhandled;
  }
}
