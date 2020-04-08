/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { DefaultBrowser, DefaultBrowserProvider } from '../../common/defaultBrowserProvider';
import { stub } from 'sinon';
import { expect } from 'chai';

describe('defaultBrowserProvider', () => {
  // only test win32, as linux/osx are provided by an npm module
  describe('win32', () => {
    const cases = [
      {
        output:
          '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice\r\n    ProgId    REG_SZ    AppXq0fevzme2pys62n3e0fbqa7peapykr8v\r\n\r\n',
        expected: DefaultBrowser.OldEdge,
      },
      {
        output:
          '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice\r\n    ProgId    REG_SZ    MSEdgeDHTML\r\n\r\n',
        expected: DefaultBrowser.Edge,
      },
      {
        output:
          '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice\r\n    ProgId    REG_SZ    ChromeHTML\r\n\r\n',
        expected: DefaultBrowser.Chrome,
      },
      {
        output:
          '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice\r\n    ProgId    REG_SZ    IE.HTTP\r\n\r\n',
        expected: DefaultBrowser.IE,
      },
      {
        output:
          '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice\r\n    ProgId    REG_SZ    FirefoxURL\r\n\r\n',
        expected: DefaultBrowser.Firefox,
      },
      {
        output:
          '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice\r\n    ProgId    REG_SZ    Potato\r\n\r\n',
        expected: undefined,
      },
    ];

    for (const { output, expected } of cases) {
      it(`gets browser ${expected}`, async () => {
        const execa = stub().resolves({ stdout: output });
        const provider = new DefaultBrowserProvider(execa as any, 'win32');
        expect(await provider.lookup()).to.equal(expected);
      });
    }
  });
});
