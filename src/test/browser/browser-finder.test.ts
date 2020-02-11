/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { DarwinChromeBrowserFinder } from '../../targets/browser/findBrowser/darwinChrome';
import { stub } from 'sinon';
import { expect } from 'chai';
import { Quality } from '../../targets/browser/findBrowser';
import { DarwinEdgeBrowserFinder } from '../../targets/browser/findBrowser/darwinEdge';
import { WindowsChromeBrowserFinder } from '../../targets/browser/findBrowser/windowsChrome';
import { WindowsEdgeBrowserFinder } from '../../targets/browser/findBrowser/windowsEdge';

describe('browser finder', () => {
  describe('darwin: chrome', () => {
    const lsreturn = [
      ' /Applications/Google Chrome.app',
      ' /Users/foo/Applications (Parallels)/{f5861500-b6d1-4929-b85d-d920e2656184} Applications.localized/Google Chrome.app',
      '/Applications/Google Chrome.app',
      ' /Applications/Google Chrome Canary.app',
    ];

    const test = (options: { lsreturn: string[]; pathsThatExist: string[] }) => {
      const execa = {
        command: stub().resolves({ stdout: options.lsreturn.join('\n') }),
      };

      const fs = {
        access: (path: string) => {
          if (!options.pathsThatExist.includes(path)) {
            throw new Error('no access here!');
          }
        },
      };

      const finder = new DarwinChromeBrowserFinder(
        { CHROME_PATH: '/custom/path' },
        execa as any,
        fs as any,
      );

      return finder.findAll();
    };

    it('does not return when paths dont exist', async () => {
      expect(
        await test({
          lsreturn,
          pathsThatExist: [],
        }),
      ).to.be.empty;
    });

    it('returns and orders correctly', async () => {
      expect(
        await test({
          lsreturn,
          pathsThatExist: [
            '/custom/path/Contents/MacOS/Google Chrome',
            '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
            '/Users/foo/Applications (Parallels)/{f5861500-b6d1-4929-b85d-d920e2656184} Applications.localized/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          ],
        }),
      ).to.deep.equal([
        {
          path: '/custom/path/Contents/MacOS/Google Chrome',
          quality: Quality.Custom,
        },
        {
          path: '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
          quality: Quality.Canary,
        },
        {
          path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          quality: Quality.Stable,
        },
        {
          path:
            '/Users/foo/Applications (Parallels)/{f5861500-b6d1-4929-b85d-d920e2656184} Applications.localized/Google Chrome.app/Contents/MacOS/Google Chrome',
          quality: Quality.Dev,
        },
      ]);
    });
  });

  describe('darwin: edge', () => {
    const lsreturn = [
      '/Applications/Microsoft Edge Beta.app',
      ' /Applications/Microsoft Edge Dev.app/Contents/Frameworks/Microsoft Edge Framework.framework/Versions/77.0.218.4/Helpers/Microsoft Edge Helper.app',
      ' /Applications/Microsoft Edge Dev.app/Contents/Frameworks/Microsoft Edge Framework.framework/Versions/77.0.197.1/Helpers/Microsoft Edge Helper.app',
      ' /Applications/Microsoft Edge Dev.app/Contents/Frameworks/Microsoft Edge Framework.framework/Versions/77.0.223.0/Helpers/Microsoft Edge Helper.app',
      ' /Applications/Microsoft Edge Dev.app',
      ' /Applications/Microsoft Edge Beta.localized/Microsoft Edge Beta.app',
      ' /Applications/Microsoft Edge Beta.app',
      ' /Applications/Microsoft Edge Dev.app/Contents/Frameworks/Microsoft Edge Framework.framework/Versions/77.0.211.2/Helpers/Microsoft Edge Helper.app',
      ' /Applications/Microsoft Edge Dev.app/Contents/Frameworks/Microsoft Edge Framework.framework/Versions/77.0.211.3/Helpers/Microsoft Edge Helper.app',
      '  /Applications/Microsoft Edge Beta.app/Contents/Frameworks/Microsoft Edge Framework.framework/Versions/79.0.309.65/Helpers/Microsoft Edge Helper.app',
      ' /Applications/Microsoft Edge Canary.app',
      ' /Applications/Microsoft Edge Beta.app',
    ];

    const test = (options: { lsreturn: string[]; pathsThatExist: string[] }) => {
      const execa = {
        command: stub().resolves({ stdout: options.lsreturn.join('\n') }),
      };

      const fs = {
        access: (path: string) => {
          if (!options.pathsThatExist.includes(path)) {
            throw new Error('no access here!');
          }
        },
      };

      const finder = new DarwinEdgeBrowserFinder(
        { EDGE_PATH: '/custom/path' },
        execa as any,
        fs as any,
      );

      return finder.findAll();
    };

    it('does not return when paths dont exist', async () => {
      expect(
        await test({
          lsreturn,
          pathsThatExist: [],
        }),
      ).to.be.empty;
    });

    it('returns and orders correctly', async () => {
      expect(
        await test({
          lsreturn,
          pathsThatExist: [
            '/custom/path/Contents/MacOS/Microsoft Edge Dev',
            '/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta',
            '/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          ],
        }),
      ).to.deep.equal([
        {
          path: '/custom/path/Contents/MacOS/Microsoft Edge Dev',
          quality: Quality.Custom,
        },
        {
          path: '/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev',
          quality: Quality.Dev,
        },
        {
          path: '/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta',
          quality: Quality.Beta,
        },
        {
          path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          quality: Quality.Stable,
        },
      ]);
    });
  });

  describe('windows: chrome', () => {
    const test = (pathsThatExist: string[]) => {
      const fs = {
        access: (path: string) => {
          if (!pathsThatExist.includes(path)) {
            throw new Error('no access here!');
          }
        },
      };

      return new WindowsChromeBrowserFinder(
        {
          LOCALAPPDATA: '%APPDATA%',
          PROGRAMFILES: '%PROGRAMFILES%',
          'PROGRAMFILES(X86)': '%PROGRAMFILES(X86)%',
          CHROME_PATH: 'C:\\custom\\path\\chrome.exe',
        },
        fs as any,
      ).findAll();
    };

    it('does not return when paths dont exist', async () => {
      expect(await test([])).to.be.empty;
    });

    it('returns and orders correctly', async () => {
      expect(
        await test([
          'C:\\custom\\path\\chrome.exe',
          '%PROGRAMFILES%\\Google\\Chrome SxS\\Application\\chrome.exe',
          '%APPDATA%\\Google\\Chrome\\Application\\chrome.exe',
          '%APPDATA%\\Google\\Chrome SxS\\Application\\chrome.exe',
        ]),
      ).to.deep.equal([
        {
          path: 'C:\\custom\\path\\chrome.exe',
          quality: Quality.Custom,
        },
        {
          path: '%APPDATA%\\Google\\Chrome SxS\\Application\\chrome.exe',
          quality: Quality.Canary,
        },
        {
          path: '%APPDATA%\\Google\\Chrome\\Application\\chrome.exe',
          quality: Quality.Stable,
        },
        {
          path: '%PROGRAMFILES%\\Google\\Chrome SxS\\Application\\chrome.exe',
          quality: Quality.Canary,
        },
      ]);
    });
  });

  describe('windows: edge', () => {
    const test = (pathsThatExist: string[]) => {
      const fs = {
        access: (path: string) => {
          if (!pathsThatExist.includes(path)) {
            throw new Error('no access here!');
          }
        },
      };

      return new WindowsEdgeBrowserFinder(
        {
          LOCALAPPDATA: '%APPDATA%',
          PROGRAMFILES: '%PROGRAMFILES%',
          'PROGRAMFILES(X86)': '%PROGRAMFILES(X86)%',
          EDGE_PATH: 'C:\\custom\\path\\edge.exe',
        },
        fs as any,
      ).findAll();
    };

    it('does not return when paths dont exist', async () => {
      expect(await test([])).to.be.empty;
    });

    it('returns and orders correctly', async () => {
      expect(
        await test([
          'C:\\custom\\path\\edge.exe',
          '%PROGRAMFILES%\\Microsoft\\Edge SxS\\Application\\msedge.exe',
          '%PROGRAMFILES%\\Microsoft\\Edge Dev\\Application\\msedge.exe',
          '%APPDATA%\\Microsoft\\Edge\\Application\\msedge.exe',
          '%APPDATA%\\Microsoft\\Edge SxS\\Application\\msedge.exe',
        ]),
      ).to.deep.equal([
        {
          path: 'C:\\custom\\path\\edge.exe',
          quality: Quality.Custom,
        },
        {
          path: '%APPDATA%\\Microsoft\\Edge SxS\\Application\\msedge.exe',
          quality: Quality.Canary,
        },
        {
          path: '%APPDATA%\\Microsoft\\Edge\\Application\\msedge.exe',
          quality: Quality.Stable,
        },
        {
          path: '%PROGRAMFILES%\\Microsoft\\Edge SxS\\Application\\msedge.exe',
          quality: Quality.Canary,
        },
        {
          path: '%PROGRAMFILES%\\Microsoft\\Edge Dev\\Application\\msedge.exe',
          quality: Quality.Dev,
        },
      ]);
    });
  });
});
