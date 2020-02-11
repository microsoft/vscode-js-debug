/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { sort } from './util';
import { injectable } from 'inversify';
import { Quality, IBrowserFinder } from './index';
import { DarwinFinderBase } from './darwinFinderBase';

/**
 * Finds the Chrome browser on OS X.
 */
@injectable()
export class DarwinChromeBrowserFinder extends DarwinFinderBase implements IBrowserFinder {
  public async findAll() {
    const suffixes = ['/Contents/MacOS/Google Chrome Canary', '/Contents/MacOS/Google Chrome'];
    const defaultPaths = ['/Applications/Google Chrome.app'];
    const installations = await this.findLaunchRegisteredApps(
      'google chrome\\( canary\\)\\?.app$',
      defaultPaths,
      suffixes,
    );

    return sort(
      installations,
      this.createPriorities([
        {
          name: 'Chrome.app',
          weight: 0,
          quality: Quality.Stable,
        },
        {
          name: 'Chrome Canary.app',
          weight: 1,
          quality: Quality.Canary,
        },
      ]),
    );
  }

  public getPreferredPath() {
    return this.env.CHROME_PATH;
  }
}
