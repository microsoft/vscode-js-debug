/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { expect } from 'chai';
import { SinonStub, stub } from 'sinon';
import { promises as dns } from 'dns';
import * as os from 'os';
import {
  fileUrlToAbsolutePath,
  createTargetFilter,
  urlToRegex,
  setCaseSensitivePaths,
  resetCaseSensitivePaths,
  isLoopback,
} from '../../common/urlUtils';

describe('urlUtils', () => {
  describe('fileUrlToPath()', () => {
    it('removes file:///', () => {
      expect(fileUrlToAbsolutePath('file:///c:/file.js')).to.equal('c:\\file.js');
    });

    it('unescape when doing url -> path', () => {
      expect(fileUrlToAbsolutePath('file:///c:/path%20with%20spaces')).to.equal(
        'c:\\path with spaces',
      );
    });

    it('ensures local path starts with / on OSX', () => {
      const platform = stub(os, 'platform').returns('darwin');
      expect(fileUrlToAbsolutePath('file:///Users/scripts/app.js')).to.equal(
        '/Users/scripts/app.js',
      );
      platform.restore();
    });

    it('force lowercase drive letter on Win to match VS Code', () => {
      // note default 'os' mock is win32
      expect(fileUrlToAbsolutePath('file:///D:/FILE.js')).to.equal('d:\\FILE.js');
    });

    it('ignores non-file URLs', () => {
      const url = 'http://localhost/blah';
      expect(fileUrlToAbsolutePath(url)).to.be.undefined;
    });

    it('works for file urls that contain : elsewhere', () => {
      // Should remove query args?
      const expectedPath = '/Users/me/file?config={"a":"b"}';
      expect(fileUrlToAbsolutePath('file://' + expectedPath)).to.equal(expectedPath);
    });
  });

  const testUrlToRegex = (input: string, expectedRe: string) => {
    const actualRe = urlToRegex(input);
    expect(actualRe).to.equal(expectedRe);
    expect(input).to.match(new RegExp(actualRe));
  };

  describe('urlToRegex - case sensitive', () => {
    before(() => setCaseSensitivePaths(true));
    after(() => resetCaseSensitivePaths());

    it('works for a simple posix path', () => {
      testUrlToRegex('file:///a/b.js', 'file:\\/\\/\\/a\\/b\\.js|\\/a\\/b\\.js');
    });

    it('works for a simple windows path', () => {
      testUrlToRegex('file:///c:/a/b.js', 'file:\\/\\/\\/[Cc]:\\/a\\/b\\.js|[Cc]:\\\\a\\\\b\\.js');
    });

    it('works for a url', () => {
      testUrlToRegex('http://localhost:8080/a/b.js', 'http:\\/\\/localhost:8080\\/a\\/b\\.js');
    });

    it('space in path', () => {
      testUrlToRegex(
        'file:///a/space%20path.js',
        'file:\\/\\/\\/a\\/space(?: |%20)path\\.js|\\/a\\/space(?: |%20)path\\.js',
      );
    });
    it('preserves high unicode (#496)', () => {
      testUrlToRegex(
        'file:///c:/foo/%E2%91%A0%E2%85%AB%E3%84%A8%E3%84%A9%20%E5%95%8A%E9%98%BF%E9%BC%BE%E9%BD%84%E4%B8%82%E4%B8%84%E7%8B%9A%E7%8B%9B%E7%8B%9C%E7%8B%9D%EF%A8%A8%EF%A8%A9%CB%8A%CB%8B%CB%99%E2%80%93%E2%BF%BB%E3%80%87%E3%90%80%E3%90%81%E4%B6%B4%E4%B6%B5U1[%EE%80%A5%EE%80%A6%EE%80%A7%EE%80%B8%EE%80%B9]U2[%EE%89%9A%EE%89%9B%EE%89%AC%EE%89%AD]U3[%EE%93%BE%EE%93%BF%EE%94%80%EE%94%8B%EE%94%8C].js',
        'file:\\/\\/\\/[Cc]:\\/foo\\/(?:①|%E2%91%A0)(?:Ⅻ|%E2%85%AB)(?:ㄨ|%E3%84%A8)(?:ㄩ|%E3%84%A9)(?: |%20)(?:啊|%E5%95%8A)(?:阿|%E9%98%BF)(?:鼾|%E9%BC%BE)(?:齄|%E9%BD%84)(?:丂|%E4%B8%82)(?:丄|%E4%B8%84)(?:狚|%E7%8B%9A)(?:狛|%E7%8B%9B)(?:狜|%E7%8B%9C)(?:狝|%E7%8B%9D)(?:﨨|%EF%A8%A8)(?:﨩|%EF%A8%A9)(?:ˊ|%CB%8A)(?:ˋ|%CB%8B)(?:˙|%CB%99)(?:–|%E2%80%93)(?:⿻|%E2%BF%BB)(?:〇|%E3%80%87)(?:㐀|%E3%90%80)(?:㐁|%E3%90%81)(?:䶴|%E4%B6%B4)(?:䶵|%E4%B6%B5)U1(?:\\[|%5B)(?:|%EE%80%A5)(?:|%EE%80%A6)(?:|%EE%80%A7)(?:|%EE%80%B8)(?:|%EE%80%B9)(?:\\]|%5D)U2(?:\\[|%5B)(?:|%EE%89%9A)(?:|%EE%89%9B)(?:|%EE%89%AC)(?:|%EE%89%AD)(?:\\]|%5D)U3(?:\\[|%5B)(?:|%EE%93%BE)(?:|%EE%93%BF)(?:|%EE%94%80)(?:|%EE%94%8B)(?:|%EE%94%8C)(?:\\]|%5D)\\.js|[Cc]:\\\\foo\\\\(?:①|%E2%91%A0)(?:Ⅻ|%E2%85%AB)(?:ㄨ|%E3%84%A8)(?:ㄩ|%E3%84%A9)(?: |%20)(?:啊|%E5%95%8A)(?:阿|%E9%98%BF)(?:鼾|%E9%BC%BE)(?:齄|%E9%BD%84)(?:丂|%E4%B8%82)(?:丄|%E4%B8%84)(?:狚|%E7%8B%9A)(?:狛|%E7%8B%9B)(?:狜|%E7%8B%9C)(?:狝|%E7%8B%9D)(?:﨨|%EF%A8%A8)(?:﨩|%EF%A8%A9)(?:ˊ|%CB%8A)(?:ˋ|%CB%8B)(?:˙|%CB%99)(?:–|%E2%80%93)(?:⿻|%E2%BF%BB)(?:〇|%E3%80%87)(?:㐀|%E3%90%80)(?:㐁|%E3%90%81)(?:䶴|%E4%B6%B4)(?:䶵|%E4%B6%B5)U1(?:\\[|%5B)(?:|%EE%80%A5)(?:|%EE%80%A6)(?:|%EE%80%A7)(?:|%EE%80%B8)(?:|%EE%80%B9)(?:\\]|%5D)U2(?:\\[|%5B)(?:|%EE%89%9A)(?:|%EE%89%9B)(?:|%EE%89%AC)(?:|%EE%89%AD)(?:\\]|%5D)U3(?:\\[|%5B)(?:|%EE%93%BE)(?:|%EE%93%BF)(?:|%EE%94%80)(?:|%EE%94%8B)(?:|%EE%94%8C)(?:\\]|%5D)\\.js',
      );
    });
  });

  describe('urlToRegex - case insensitive', () => {
    before(() => setCaseSensitivePaths(false));
    after(() => resetCaseSensitivePaths());

    it('works for a simple posix path', () => {
      testUrlToRegex(
        'file:///a/b.js',
        '[fF][iI][lL][eE]:\\/\\/\\/[aA]\\/[bB]\\.[jJ][sS]|\\/[aA]\\/[bB]\\.[jJ][sS]',
      );
    });

    it('works for a simple windows path', () => {
      testUrlToRegex(
        'file:///c:/a/b.js',
        '[fF][iI][lL][eE]:\\/\\/\\/[cC]:\\/[aA]\\/[bB]\\.[jJ][sS]|[cC]:\\\\[aA]\\\\[bB]\\.[jJ][sS]',
      );
    });

    it('works for a url', () => {
      testUrlToRegex(
        'http://localhost:8080/a/b.js',
        '[hH][tT][tT][pP]:\\/\\/[lL][oO][cC][aA][lL][hH][oO][sS][tT]:8080\\/[aA]\\/[bB]\\.[jJ][sS]',
      );
    });

    it('space in path', () => {
      testUrlToRegex(
        'file:///a/space%20path.js',
        '[fF][iI][lL][eE]:\\/\\/\\/[aA]\\/[sS][pP][aA][cC][eE](?: |%20)[pP][aA][tT][hH]\\.[jJ][sS]|\\/[aA]\\/[sS][pP][aA][cC][eE](?: |%20)[pP][aA][tT][hH]\\.[jJ][sS]',
      );
    });

    it('preserves high unicode (#496)', () => {
      testUrlToRegex(
        'file:///c:/foo/%E2%91%A0%E2%85%AB%E3%84%A8%E3%84%A9%20%E5%95%8A%E9%98%BF%E9%BC%BE%E9%BD%84%E4%B8%82%E4%B8%84%E7%8B%9A%E7%8B%9B%E7%8B%9C%E7%8B%9D%EF%A8%A8%EF%A8%A9%CB%8A%CB%8B%CB%99%E2%80%93%E2%BF%BB%E3%80%87%E3%90%80%E3%90%81%E4%B6%B4%E4%B6%B5U1[%EE%80%A5%EE%80%A6%EE%80%A7%EE%80%B8%EE%80%B9]U2[%EE%89%9A%EE%89%9B%EE%89%AC%EE%89%AD]U3[%EE%93%BE%EE%93%BF%EE%94%80%EE%94%8B%EE%94%8C].js',
        '[fF][iI][lL][eE]:\\/\\/\\/[cC]:\\/[fF][oO][oO]\\/(?:①|%E2%91%A0)(?:ⅻ|%E2%85%BB|Ⅻ|%E2%85%AB)(?:ㄨ|%E3%84%A8)(?:ㄩ|%E3%84%A9)(?: |%20)(?:啊|%E5%95%8A)(?:阿|%E9%98%BF)(?:鼾|%E9%BC%BE)(?:齄|%E9%BD%84)(?:丂|%E4%B8%82)(?:丄|%E4%B8%84)(?:狚|%E7%8B%9A)(?:狛|%E7%8B%9B)(?:狜|%E7%8B%9C)(?:狝|%E7%8B%9D)(?:﨨|%EF%A8%A8)(?:﨩|%EF%A8%A9)(?:ˊ|%CB%8A)(?:ˋ|%CB%8B)(?:˙|%CB%99)(?:–|%E2%80%93)(?:⿻|%E2%BF%BB)(?:〇|%E3%80%87)(?:㐀|%E3%90%80)(?:㐁|%E3%90%81)(?:䶴|%E4%B6%B4)(?:䶵|%E4%B6%B5)[uU]1(?:\\[|%5B)(?:|%EE%80%A5)(?:|%EE%80%A6)(?:|%EE%80%A7)(?:|%EE%80%B8)(?:|%EE%80%B9)(?:\\]|%5D)[uU]2(?:\\[|%5B)(?:|%EE%89%9A)(?:|%EE%89%9B)(?:|%EE%89%AC)(?:|%EE%89%AD)(?:\\]|%5D)[uU]3(?:\\[|%5B)(?:|%EE%93%BE)(?:|%EE%93%BF)(?:|%EE%94%80)(?:|%EE%94%8B)(?:|%EE%94%8C)(?:\\]|%5D)\\.[jJ][sS]|[cC]:\\\\[fF][oO][oO]\\\\(?:①|%E2%91%A0)(?:ⅻ|%E2%85%BB|Ⅻ|%E2%85%AB)(?:ㄨ|%E3%84%A8)(?:ㄩ|%E3%84%A9)(?: |%20)(?:啊|%E5%95%8A)(?:阿|%E9%98%BF)(?:鼾|%E9%BC%BE)(?:齄|%E9%BD%84)(?:丂|%E4%B8%82)(?:丄|%E4%B8%84)(?:狚|%E7%8B%9A)(?:狛|%E7%8B%9B)(?:狜|%E7%8B%9C)(?:狝|%E7%8B%9D)(?:﨨|%EF%A8%A8)(?:﨩|%EF%A8%A9)(?:ˊ|%CB%8A)(?:ˋ|%CB%8B)(?:˙|%CB%99)(?:–|%E2%80%93)(?:⿻|%E2%BF%BB)(?:〇|%E3%80%87)(?:㐀|%E3%90%80)(?:㐁|%E3%90%81)(?:䶴|%E4%B6%B4)(?:䶵|%E4%B6%B5)[uU]1(?:\\[|%5B)(?:|%EE%80%A5)(?:|%EE%80%A6)(?:|%EE%80%A7)(?:|%EE%80%B8)(?:|%EE%80%B9)(?:\\]|%5D)[uU]2(?:\\[|%5B)(?:|%EE%89%9A)(?:|%EE%89%9B)(?:|%EE%89%AC)(?:|%EE%89%AD)(?:\\]|%5D)[uU]3(?:\\[|%5B)(?:|%EE%93%BE)(?:|%EE%93%BF)(?:|%EE%94%80)(?:|%EE%94%8B)(?:|%EE%94%8C)(?:\\]|%5D)\\.[jJ][sS]',
      );
    });
  });

  describe('createTargetFilter()', () => {
    function testAll(filter: string, cases: [string, boolean][]) {
      const filterFn = createTargetFilter(filter);
      for (const [url, expected] of cases) {
        expect(filterFn(url)).to.equal(
          expected,
          `expected ${url} to ${expected ? '' : 'not '}match ${filter}`,
        );
      }
    }

    it('returns exact match', () => {
      testAll('http://localhost/site', [
        ['http://localhost/site/page', false],
        ['http://localhost/site', true],
      ]);
    });

    it('ignores the url protocol', () => {
      testAll('https://localhost', [
        ['https://outlook.com', false],
        ['http://localhost', true],
      ]);
    });

    it('really ignores the url protocol', () => {
      testAll('localhost', [
        ['https://outlook.com', false],
        ['http://localhost', true],
      ]);
    });

    it('is case-insensitive', () => {
      testAll('http://LOCALHOST', [
        ['http://localhost/site', false],
        ['http://localhost', true],
      ]);
    });

    it('does not return substring fuzzy match as in pre 0.1.9', () => {
      testAll('http://localhost/site/page', [['http://localhost/site', false]]);
    });

    it('respects one wildcard', () => {
      testAll('localhost/site/*', [
        ['http://localhost/site/app', true],
        ['http://localhost/site/', false],
        ['http://localhost/', false],
      ]);
    });

    it('respects wildcards with query params', () => {
      testAll('localhost:3000/site/?*', [
        ['http://localhost:3000/site/?blah=1', true],
        ['http://localhost:3000/site/?blah=2', true],
        ['http://localhost:3000/site/', false],
      ]);
    });

    it('works with special chars', () => {
      testAll('http://localhost(foo)/[bar]/?baz', [
        ['http://localhost(foo)/[bar]/?baz', true],
        ['http://localhost(foo)/bar/?words', false],
        ['http://localhost/[bar]/?(somethingelse)', false],
      ]);
    });

    it('works with special chars + wildcard', () => {
      testAll('http://localhost/[bar]/?(*)', [
        ['http://localhost/[bar]/?(words)', true],
        ['http://localhost/bar/?words', false],
        ['http://localhost/[bar]/?(somethingelse)', true],
      ]);
    });

    it('matches an ending slash', () => {
      testAll('http://localhost', [
        ['http://localhost/', true],
        ['http://localhost', true],
      ]);
    });

    it('works with file://', () => {
      testAll('/foo/bar', [
        ['file:///foo/bar', true],
        ['http://localhost', false],
      ]);
    });

    it('works with file:// + query params', () => {
      testAll('/foo/bar?a://*', [
        ['file:///foo/bar?a%3A%2F%2Fb', true],
        ['http://localhost', false],
      ]);
    });
  });

  describe('isLoopback', () => {
    let lookupStub: SinonStub;

    beforeEach(() => {
      lookupStub = stub(dns, 'lookup');
      lookupStub.callThrough();
      lookupStub.withArgs('contoso.com').resolves({ address: '1.1.1.1' });
      lookupStub.withArgs('local.contoso.com').resolves({ address: '127.0.0.1' });
    });

    afterEach(() => {
      isLoopback.clear();
      lookupStub.restore();
    });

    const ttable = {
      '127.0.0.1': true,
      'http://127.1/foo': true,
      'http://1.1.1.1/foo': false,
      'totes invalid': false,
      '1.1.1.1': false,
      '::1': true,
      ':1:1': false,
      'http://[::1]/foo': true,
      'http://[:1:1]/foo': false,

      'http://contoso.com/foo': false,
      'http://local.contoso.com/foo': true,
    };

    // Alternative forms supported by posix:
    if (process.platform !== 'win32') {
      Object.assign(ttable, {
        '127.1': true,
        '0x7f000001': true,
      });
    }

    for (const [ip, expected] of Object.entries(ttable)) {
      it(ip, async () => expect(await isLoopback(ip)).to.equal(expected));
    }
  });
});
