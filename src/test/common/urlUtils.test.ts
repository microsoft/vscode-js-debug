/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { expect } from 'chai';
import { stub } from 'sinon';
import * as os from 'os';
import {
  fileUrlToAbsolutePath,
  createTargetFilter,
  urlToRegex,
  setCaseSensitivePaths,
  resetCaseSensitivePaths,
  truePathCasing,
  getCaseSensitivePaths,
} from '../../common/urlUtils';
import { createFileTree, testFixturesDir } from '../test';
import { join } from 'path';

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

  describe('truePathCasing()', () => {
    it('works', async () => {
      createFileTree(testFixturesDir, {
        'foo/Bar/BAZ.txt': 'hello.txt',
      });

      const correct = join(testFixturesDir, 'foo/Bar/BAZ.txt');
      const incorrect = join(testFixturesDir, 'FOO/bar/baz.txt');
      expect(await truePathCasing(correct)).to.equal(correct);

      if (getCaseSensitivePaths()) {
        expect(await truePathCasing(incorrect)).to.equal(incorrect);
      } else {
        expect(await truePathCasing(incorrect)).to.equal(correct);
      }
    });
  });

  describe('urlToRegex - case sensitive', () => {
    before(() => setCaseSensitivePaths(true));
    after(() => resetCaseSensitivePaths());

    it('works for a simple posix path', () => {
      expect(urlToRegex('file:///a/b.js')).to.equal('file:\\/\\/\\/a\\/b\\.js|\\/a\\/b\\.js');
    });

    it('works for a simple windows path', () => {
      expect(urlToRegex('file:///c:/a/b.js')).to.equal(
        'file:\\/\\/\\/[Cc]:\\/a\\/b\\.js|[Cc]:\\\\a\\\\b\\.js',
      );
    });

    it('works for a url', () => {
      expect(urlToRegex('http://localhost:8080/a/b.js')).to.equal(
        'http:\\/\\/localhost:8080\\/a\\/b\\.js',
      );
    });

    it('space in path', () => {
      expect(urlToRegex('file:///a/space%20path.js')).to.equal(
        'file:\\/\\/\\/a\\/space( |%20)path\\.js|\\/a\\/space( |%20)path\\.js',
      );
    });
  });

  describe('urlToRegex - case insensitive', () => {
    before(() => setCaseSensitivePaths(false));
    after(() => resetCaseSensitivePaths());

    it('works for a simple posix path', () => {
      expect(urlToRegex('file:///a/b.js')).to.equal(
        '[fF][iI][lL][eE]:\\/\\/\\/[aA]\\/[bB]\\.[jJ][sS]|\\/[aA]\\/[bB]\\.[jJ][sS]',
      );
    });

    it('works for a simple windows path', () => {
      expect(urlToRegex('file:///c:/a/b.js')).to.equal(
        '[fF][iI][lL][eE]:\\/\\/\\/[cC]:\\/[aA]\\/[bB]\\.[jJ][sS]|[cC]:\\\\[aA]\\\\[bB]\\.[jJ][sS]',
      );
    });

    it('works for a url', () => {
      expect(urlToRegex('http://localhost:8080/a/b.js')).to.equal(
        '[hH][tT][tT][pP]:\\/\\/[lL][oO][cC][aA][lL][hH][oO][sS][tT]:8080\\/[aA]\\/[bB]\\.[jJ][sS]',
      );
    });

    it('space in path', () => {
      expect(urlToRegex('file:///a/space%20path.js')).to.equal(
        '[fF][iI][lL][eE]:\\/\\/\\/[aA]\\/[sS][pP][aA][cC][eE]( |%20)[pP][aA][tT][hH]\\.[jJ][sS]|\\/[aA]\\/[sS][pP][aA][cC][eE]( |%20)[pP][aA][tT][hH]\\.[jJ][sS]',
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
});
