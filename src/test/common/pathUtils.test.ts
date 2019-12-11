/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { expect } from 'chai';
import { forceForwardSlashes, fixDriveLetterAndSlashes } from '../../common/pathUtils';

describe('pathUtils', () => {
  describe('forceForwardSlashes', () => {
    it('works for c:/... cases', () => {
      expect(forceForwardSlashes('C:\\foo\\bar')).to.equal('C:/foo/bar');
      expect(forceForwardSlashes('C:\\')).to.equal('C:/');
      expect(forceForwardSlashes('C:/foo\\bar')).to.equal('C:/foo/bar');
    });

    it('works for relative paths', () => {
      expect(forceForwardSlashes('foo\\bar')).to.equal('foo/bar');
      expect(forceForwardSlashes('foo\\bar/baz')).to.equal('foo/bar/baz');
    });

    it('fixes escaped forward slashes', () => {
      expect(forceForwardSlashes('foo\\/bar')).to.equal('foo/bar');
    });
  });

  describe('fixDriveLetterAndSlashes', () => {
    it('works for c:/... cases', () => {
      expect(fixDriveLetterAndSlashes('C:/path/stuff')).to.equal('c:\\path\\stuff');
      expect(fixDriveLetterAndSlashes('c:/path\\stuff')).to.equal('c:\\path\\stuff');
      expect(fixDriveLetterAndSlashes('C:\\path')).to.equal('c:\\path');
      expect(fixDriveLetterAndSlashes('C:\\')).to.equal('c:\\');
    });

    it('works for file:/// cases', () => {
      expect(fixDriveLetterAndSlashes('file:///C:/path/stuff')).to.equal('file:///c:\\path\\stuff');
      expect(fixDriveLetterAndSlashes('file:///c:/path\\stuff')).to.equal(
        'file:///c:\\path\\stuff',
      );
      expect(fixDriveLetterAndSlashes('file:///C:\\path')).to.equal('file:///c:\\path');
      expect(fixDriveLetterAndSlashes('file:///C:\\')).to.equal('file:///c:\\');
    });

    it('does not impact posix cases', () => {
      expect(fixDriveLetterAndSlashes('file:///a/b')).to.equal('file:///a/b');
      expect(fixDriveLetterAndSlashes('/a/b')).to.equal('/a/b');
    });
  });
});
