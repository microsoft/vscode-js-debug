/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import type * as vscodeType from 'vscode';
import {
  DefaultBrowser,
  DefaultBrowserProvider,
  matchDefaultBrowser,
  parseDarwinDefaultBrowserId,
} from './defaultBrowserProvider';

class TestDefaultBrowserProvider extends DefaultBrowserProvider {
  public darwinCalls = 0;
  public defaultBrowserCalls = 0;
  public platform: NodeJS.Platform = 'darwin';
  public darwinResult: () => Promise<string> = async () => 'com.apple.Safari';
  public defaultBrowserResult: () => Promise<{ name: string; id: string }> = async () => ({
    name: 'Google Chrome',
    id: 'com.google.chrome',
  });

  protected override getPlatform(): NodeJS.Platform {
    return this.platform;
  }

  protected override async lookupDarwinDefaultBrowserId(): Promise<string> {
    this.darwinCalls++;
    return this.darwinResult();
  }

  protected override async lookupDefaultBrowser(): Promise<{ name: string; id: string }> {
    this.defaultBrowserCalls++;
    return this.defaultBrowserResult();
  }
}

describe('DefaultBrowserProvider', () => {
  it('parses macOS LSHandlers plist output including nested dicts and ignored "-" entries', () => {
    const edgePlist = `(
      {
        LSHandlerPreferredVersions = {
          LSHandlerRoleAll = "-";
        };
        LSHandlerRoleAll = "com.microsoft.edgemac";
        LSHandlerURLScheme = https;
      },
      {
        LSHandlerPreferredVersions = {
          LSHandlerRoleAll = "-";
        };
        LSHandlerRoleAll = "com.google.chrome";
        LSHandlerURLScheme = mailto;
      }
    )`;
    expect(parseDarwinDefaultBrowserId(edgePlist)).to.equal('com.microsoft.edgemac');

    const reversedKeysPlist = `(
      {
        LSHandlerURLScheme = "http";
        LSHandlerRoleAll = "org.mozilla.firefox";
      }
    )`;
    expect(parseDarwinDefaultBrowserId(reversedKeysPlist)).to.equal('org.mozilla.firefox');

    expect(parseDarwinDefaultBrowserId('()')).to.equal('com.apple.Safari');
  });

  it('matches both display names and platform bundle identifiers', () => {
    expect(matchDefaultBrowser('com.microsoft.edgemac')).to.equal(DefaultBrowser.Edge);
    expect(matchDefaultBrowser('com.microsoft.edgemac.Beta')).to.equal(DefaultBrowser.Edge);
    expect(matchDefaultBrowser('com.google.Chrome')).to.equal(DefaultBrowser.Chrome);
    expect(matchDefaultBrowser('org.mozilla.firefox')).to.equal(DefaultBrowser.Other);
    expect(matchDefaultBrowser('', 'com.microsoft.edge')).to.equal(DefaultBrowser.Edge);
    expect(matchDefaultBrowser('Microsoft Edge')).to.equal(DefaultBrowser.Edge);
  });

  it('detects Edge on darwin via permission-free bundle lookup without calling default-browser', async () => {
    const provider = new TestDefaultBrowserProvider('local');
    provider.platform = 'darwin';
    provider.darwinResult = async () => 'com.microsoft.edgemac';

    expect(await provider.lookup()).to.equal(DefaultBrowser.Edge);
    expect(await provider.lookup()).to.equal(DefaultBrowser.Edge);
    expect(provider.darwinCalls).to.equal(1);
    expect(provider.defaultBrowserCalls).to.equal(0);
  });

  it('matches id on non-darwin platforms even when display name does not contain browser name', async () => {
    const provider = new TestDefaultBrowserProvider('local');
    provider.platform = 'win32';
    provider.defaultBrowserResult = async () => ({
      name: 'Localized Browser Name',
      id: 'com.microsoft.edge',
    });

    expect(await provider.lookup()).to.equal(DefaultBrowser.Edge);
    expect(provider.defaultBrowserCalls).to.equal(1);
    expect(provider.darwinCalls).to.equal(0);
  });

  it('does not permanently cache rejected lookups and succeeds on retry', async () => {
    const provider = new TestDefaultBrowserProvider('local');
    provider.platform = 'linux';
    let attempt = 0;
    provider.defaultBrowserResult = async () => {
      attempt++;
      if (attempt === 1) {
        throw new Error('temporary failure');
      }
      return { name: 'Edge', id: 'com.microsoft.edge' };
    };

    let caught: unknown;
    try {
      await provider.lookup();
    } catch (err) {
      caught = err;
    }
    expect(caught).to.be.an('error');
    expect(await provider.lookup()).to.equal(DefaultBrowser.Edge);
    expect(provider.defaultBrowserCalls).to.equal(2);
  });

  it('uses companion command when running remotely and retries after rejection', async () => {
    let calls = 0;
    const mockVscode = {
      commands: {
        async executeCommand() {
          calls++;
          if (calls === 1) {
            throw new Error('companion unavailable');
          }
          return 'Microsoft Edge';
        },
      },
    } as unknown as typeof vscodeType;

    const provider = new TestDefaultBrowserProvider('remote', mockVscode);

    let caught: unknown;
    try {
      await provider.lookup();
    } catch (err) {
      caught = err;
    }
    expect(caught).to.be.an('error');
    expect(await provider.lookup()).to.equal(DefaultBrowser.Edge);
    expect(calls).to.equal(2);
  });
});
