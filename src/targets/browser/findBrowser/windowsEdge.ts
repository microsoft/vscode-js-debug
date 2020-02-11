/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Quality, IBrowserFinder } from './index';
import { sep } from 'path';
import { preferredEdgePath, findWindowsCandidates } from './util';
import { inject, injectable } from 'inversify';
import { ProcessEnv, FS, FsPromises } from '../../../ioc-extras';

/**
 * Finds the Chrome browser on Windows.
 */
@injectable()
export class WindowsEdgeBrowserFinder implements IBrowserFinder {
  constructor(
    @inject(ProcessEnv) private readonly env: NodeJS.ProcessEnv,
    @inject(FS) private readonly fs: FsPromises,
  ) {}

  public async findAll() {
    const suffixes = [
      {
        name: `${sep}Microsoft${sep}Edge SxS${sep}Application${sep}msedge.exe`,
        type: Quality.Canary,
      },
      {
        name: `${sep}Microsoft${sep}Edge Dev${sep}Application${sep}msedge.exe`,
        type: Quality.Dev,
      },
      {
        name: `${sep}Microsoft${sep}Edge Beta${sep}Application${sep}msedge.exe`,
        type: Quality.Beta,
      },
      {
        name: `${sep}Microsoft${sep}Edge${sep}Application${sep}msedge.exe`,
        type: Quality.Stable,
      },
    ];

    const installations = await findWindowsCandidates(this.env, this.fs, suffixes);
    const customEdgePath = await preferredEdgePath(this.fs, this.env);
    if (customEdgePath) {
      installations.unshift({ path: customEdgePath, quality: Quality.Custom });
    }

    return installations;
  }
}
