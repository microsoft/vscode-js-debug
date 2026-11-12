/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { execFile } from 'child_process';
import { inject, injectable, optional } from 'inversify';
import { promisify } from 'util';
import type * as vscodeType from 'vscode';
import { ExtensionLocation, VSCodeApi } from '../ioc-extras';
import { once } from './objUtils';

const execFileAsync = promisify(execFile);

const enum MacBrowserBundle {
  Safari = 'com.apple.Safari',
}

const lsHandlersBlockRe = /\{([^}]*)\}/g;
const lsHandlerNestedRe = /\b[A-Za-z0-9_]+\s*=\s*\{[^}]*\};?/g;
const lsHandlerWebSchemeRe = /\bLSHandlerURLScheme\s*=\s*"?(?:http|https)"?;/;
const lsHandlerRoleAllRe = /\bLSHandlerRoleAll\s*=\s*"(?!-)([^"]+)";/;

export const enum DefaultBrowser {
  Edge = 'edge',
  Chrome = 'chrome',
  Other = 'other',
}

/**
 * Parses `defaults read com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers`
 * output and returns the HTTP/HTTPS handler bundle ID without invoking AppleScript.
 */
export function parseDarwinDefaultBrowserId(stdout: string): string {
  const flattened = stdout.replace(lsHandlerNestedRe, '');
  for (const match of flattened.matchAll(lsHandlersBlockRe)) {
    const block = match[1];
    if (!lsHandlerWebSchemeRe.test(block)) {
      continue;
    }
    const roleMatch = lsHandlerRoleAllRe.exec(block);
    if (roleMatch) {
      return roleMatch[1];
    }
  }
  return MacBrowserBundle.Safari;
}

/**
 * Matches a display name or platform identifier (such as a macOS bundle ID) to
 * a supported {@link DefaultBrowser}.
 */
export function matchDefaultBrowser(...identifiers: (string | undefined)[]): DefaultBrowser {
  for (const identifier of identifiers) {
    if (!identifier) {
      continue;
    }
    const lower = identifier.toLowerCase();
    const match = [DefaultBrowser.Chrome, DefaultBrowser.Edge].find(browser =>
      lower.includes(browser)
    );
    if (match) {
      return match;
    }
  }
  return DefaultBrowser.Other;
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
   * Cache successful results of this function. This avoids repeated subprocess
   * lookups while allowing failed lookups to be retried on subsequent calls.
   * @inheritdoc
   */
  public lookup = once(async (): Promise<DefaultBrowser | undefined> => {
    try {
      if (this.location === 'remote' && this.vscode) {
        const name = await this.vscode.commands.executeCommand<string>(
          'js-debug-companion.defaultBrowser',
        );
        return matchDefaultBrowser(name);
      }

      if (this.getPlatform() === 'darwin') {
        // Query LaunchServices directly rather than via `default-browser`'s
        // AppleScript `bundle-name` step, which fails or prompts when Automation
        // permission for System Events is denied.
        const id = await this.lookupDarwinDefaultBrowserId();
        return matchDefaultBrowser(id);
      }

      const browser = await this.lookupDefaultBrowser();
      return matchDefaultBrowser(browser.name, browser.id);
    } catch (err) {
      this.lookup.forget();
      throw err;
    }
  });

  protected getPlatform(): NodeJS.Platform {
    return process.platform;
  }

  protected async lookupDarwinDefaultBrowserId(): Promise<string> {
    try {
      const { stdout } = await execFileAsync('defaults', [
        'read',
        'com.apple.LaunchServices/com.apple.launchservices.secure',
        'LSHandlers',
      ]);
      return parseDarwinDefaultBrowserId(stdout);
    } catch (err) {
      if (err instanceof Error && err.message.includes('does not exist')) {
        return MacBrowserBundle.Safari;
      }
      throw err;
    }
  }

  protected async lookupDefaultBrowser(): Promise<{ name: string; id: string }> {
    return import('default-browser').then(d => d.default());
  }
}
