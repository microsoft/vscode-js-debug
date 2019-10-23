import { NodeSourcePathResolver } from '../../targets/node/nodeSourcePathResolver';
import { expect } from 'chai';
import { join } from 'path';

describe('node source path resolver', () => {
  describe('url to path', () => {
    it('resolves absolute', () => {
      const r = new NodeSourcePathResolver({
        basePath: __dirname,
        remoteRoot: null,
        localRoot: null,
        sourceMapOverrides: { 'webpack:///*': '*' },
      });

      expect(r.urlToAbsolutePath('file:///src/index.js')).to.equal('/src/index.js');
    });

    it('normalizes roots (win -> posix) ', () => {
      const r = new NodeSourcePathResolver({
        basePath: __dirname,
        remoteRoot: 'C:\\Source',
        localRoot: '/dev/src',
        sourceMapOverrides: { 'webpack:///*': '*' },
      });

      expect(r.urlToAbsolutePath('file:///c:/source/foo/bar.js')).to.equal('/dev/src/foo/bar.js');
    });

    it('normalizes roots (posix -> win) ', () => {
      const r = new NodeSourcePathResolver({
        basePath: __dirname,
        remoteRoot: '/dev/src',
        localRoot: 'C:\\Source',
        sourceMapOverrides: { 'webpack:///*': '*' },
      });

      expect(r.urlToAbsolutePath('file:///dev/src/foo/bar.js')).to.equal('c:\\Source\\foo\\bar.js');
    });

    it('applies source map overrides', () => {
      const r = new NodeSourcePathResolver({
        basePath: __dirname,
        remoteRoot: null,
        localRoot: null,
        sourceMapOverrides: { 'webpack:///*': '*' },
      });

      expect(r.urlToAbsolutePath('webpack:///hello.js')).to.equal(join(__dirname, 'hello.js'));
    });
  })
});
