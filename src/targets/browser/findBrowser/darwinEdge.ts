/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { sort } from './util';
import { injectable } from 'inversify';
import { Quality, IBrowserFinder } from './index';
import { DarwinFinderBase } from './darwinFinderBase';

/**
 * Finds the Edege browser on OS X.
 */
@injectable()
export class DarwinEdgeBrowserFinder extends DarwinFinderBase implements IBrowserFinder {
  public async findAll() {
    const suffixes = [
      '/Contents/MacOS/Microsoft Edge Canary',
      '/Contents/MacOS/Microsoft Edge Beta',
      '/Contents/MacOS/Microsoft Edge Dev',
      '/Contents/MacOS/Microsoft Edge',
    ];

    const defaultPaths = ['/Applications/Microsoft Edge.app'];
    const installations = await this.findLaunchRegisteredApps(
      'Microsoft Edge[A-Za-z ]*.app$',
      defaultPaths,
      suffixes,
    );

    return sort(
      installations,
      this.createPriorities([
        {
          name: 'Microsoft Edge.app',
          weight: 0,
          quality: Quality.Stable,
        },
        {
          name: 'Microsoft Edge Canary.app',
          weight: 1,
          quality: Quality.Canary,
        },
        {
          name: 'Microsoft Edge Beta.app',
          weight: 2,
          quality: Quality.Beta,
        },
        {
          name: 'Microsoft Edge Dev.app',
          weight: 3,
          quality: Quality.Dev,
        },
      ]),
    );
  }

  protected getPreferredPath() {
    return this.env.EDGE_PATH;
  }
}
