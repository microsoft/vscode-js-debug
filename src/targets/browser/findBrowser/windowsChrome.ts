/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Quality, IBrowserFinder } from './index';
import { win32 } from 'path';
import { preferredChromePath, findWindowsCandidates } from './util';
import { inject, injectable } from 'inversify';
import { ProcessEnv, FsPromises, FS } from '../../../ioc-extras';

/**
 * Finds the Chrome browser on Windows.
 */
@injectable()
export class WindowsChromeBrowserFinder implements IBrowserFinder {
  constructor(
    @inject(ProcessEnv) private readonly env: NodeJS.ProcessEnv,
    @inject(FS) private readonly fs: FsPromises,
  ) {}

  public async findAll() {
    const sep = win32.sep;
    const suffixes = [
      {
        name: `${sep}Google${sep}Chrome SxS${sep}Application${sep}chrome.exe`,
        type: Quality.Canary,
      },
      {
        name: `${sep}Google${sep}Chrome${sep}Application${sep}chrome.exe`,
        type: Quality.Stable,
      },
    ];

    const installations = await findWindowsCandidates(this.env, this.fs, suffixes);
    const customChromePath = await preferredChromePath(this.fs, this.env);
    if (customChromePath) {
      installations.unshift({ path: customChromePath, quality: Quality.Custom });
    }

    return installations;
  }
}
