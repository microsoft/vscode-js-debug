/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable, optional } from 'inversify';
import type * as vscodeType from 'vscode';
import { ExtensionLocation, VSCodeApi } from '../ioc-extras';
import { once } from './objUtils';

export const enum DefaultBrowser {
  Edge = 'edge',
  Chrome = 'chrome',
  Other = 'other',
}

/**
 * Class that looks up the default browser on the current platform.
 */
export interface IDefaultBrowserProvider {
  /**
   * Looks up the default browser, returning undefined if we're not sure. May
   * reject if some underlying lookup fails.
   */
  lookup(): Promise<DefaultBrowser | undefined>;
}

export const IDefaultBrowserProvider = Symbol('IDefaultBrowserProvider');

@injectable()
export class DefaultBrowserProvider implements IDefaultBrowserProvider {
  constructor(
    @inject(ExtensionLocation) private readonly location: ExtensionLocation,
    @optional() @inject(VSCodeApi) private readonly vscode?: typeof vscodeType,
  ) {}

  /**
   * Cache the result of this function. This adds a few milliseconds
   * (subprocesses out on all platforms) and people rarely change their
   * default browser.
   * @inheritdoc
   */
  public lookup = once(async () => {
    let name: string;
    if (this.location === 'remote' && this.vscode) {
      name = await this.vscode.commands.executeCommand('js-debug-companion.defaultBrowser');
    } else {
      name = (await import('default-browser').then(d => d.default())).name;
    }

    const match = [DefaultBrowser.Chrome, DefaultBrowser.Edge].find(browser =>
      name.toLowerCase().includes(browser)
    );
    return match ?? DefaultBrowser.Other;
  });
}
