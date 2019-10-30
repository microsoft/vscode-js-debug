import { expect } from 'chai';
import { stub } from 'sinon';
import * as os from 'os';
import { fileUrlToAbsolutePath } from '../../common/urlUtils';

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
});
