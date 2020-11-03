/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import * as path from 'path';
import { Logger } from '../common/logging/logger';
import { baseDefaults } from '../configuration';
import { SourceMapOverrides } from './sourceMapOverrides';

describe('SourceMapOverrides', () => {
  describe('functionality', () => {
    it('replaces simple paths', () => {
      const r = new SourceMapOverrides({ '/a/*': '/b/*' }, Logger.null);
      expect(r.apply('/a/foo/bar')).to.equal('/b/foo/bar');
      expect(r.apply('/q/foo/bar')).to.equal('/q/foo/bar');
    });

    it('replaces paths without groups on the right', () => {
      const r = new SourceMapOverrides({ '/a/*': '/b' }, Logger.null);
      expect(r.apply('/a/foo/bar')).to.equal('/b');
    });

    it('replaces paths without groups on the left or right', () => {
      const r = new SourceMapOverrides({ '/a': '/b' }, Logger.null);
      expect(r.apply('/a/foo/bar')).to.equal('/b/foo/bar');
      expect(r.apply('/abbbbb')).to.equal('/abbbbb');
      expect(r.apply('/a')).to.equal('/b');
    });

    it('handles non-capturing groups', () => {
      const r = new SourceMapOverrides({ '/a/?:*/*': '/b/*' }, Logger.null);
      expect(r.apply('/a/foo/bar')).to.equal('/b/bar');
    });

    it('applies longer replacements first', () => {
      const r = new SourceMapOverrides({ '/a/*': '/c', '/a/foo': '/b' }, Logger.null);
      expect(r.apply('/a/foo')).to.equal('/b');
    });

    it('preserves $ in right hand side', () => {
      const r = new SourceMapOverrides({ '/a/*': '/c/$/$1/$$/*' }, Logger.null);
      expect(r.apply('/a/foo')).to.equal('/c/$/$1/$$/foo');
    });

    it('allows raw regex', () => {
      const r = new SourceMapOverrides({ '/a/([^/]+)/(.+)': '/c/dir-$1/$2' }, Logger.null);
      expect(r.apply('/a/b/foo')).to.equal('/c/dir-b/foo');
    });

    it('normalizes slashes in returned paths (issue #401)', () => {
      const r = new SourceMapOverrides(
        {
          'webpack:/*': '${webRoot}/*',
          '/./*': '${webRoot}/*',
          '/src/*': '${webRoot}/*',
          '/*': '*',
          '/./~/*': '${webRoot}/node_modules/*',
        },
        Logger.null,
      );

      expect(r.apply('webpack:///src/app/app.component.ts')).to.equal(
        path.join('${webRoot}/src/app/app.component.ts'),
      );
    });

    it('handles meteor paths (issue #491)', () => {
      const r = new SourceMapOverrides(
        {
          'meteor:/💻app/*': '${webRoot}/*',
          'meteor://💻app/*': '${webRoot}/*',
          '~/dev/booker-meteor/meteor:/💻app/*': '${webRoot}/*',
          'packages/meteor:/💻app/*': '${workspaceFolder}/.meteor/packages/*',
        },
        Logger.null,
      );

      expect(r.apply('meteor://💻app/packages/base64/base64.js')).to.equal(
        path.join('${webRoot}/packages/base64/base64.js'),
      );
    });

    it('normalizes backslashes given in patterns (#604)', () => {
      const r = new SourceMapOverrides(
        {
          'H:\\cv-measure\\measure-tools/test-app/measure-tools/src/*':
            'H:\\cv-measure\\measure-tools/measure-tools/src/*',
        },
        Logger.null,
      );

      expect(
        r.apply('H:/cv-measure/measure-tools/test-app/measure-tools/src/api/Measurement.ts'),
      ).to.equal(
        path.win32.join('H:/cv-measure/measure-tools/measure-tools/src/api/Measurement.ts'),
      );
    });

    it('handles single file overrides', () => {
      const r = new SourceMapOverrides({ '/foo/bar.js': '${webRoot}/baz.js' }, Logger.null);
      expect(r.apply('/foo/bar.js')).to.equal(path.join('${webRoot}/baz.js'));
    });
  });

  describe('defaults', () => {
    let r: SourceMapOverrides;
    before(() => (r = new SourceMapOverrides(baseDefaults.sourceMapPathOverrides, Logger.null)));

    it('does not touch already valid paths', () => {
      expect(r.apply('https://contoso.com/foo.ts')).to.equal('https://contoso.com/foo.ts');
      expect(r.apply('file:///dev/foo.ts')).to.equal('file:///dev/foo.ts');
    });

    it('resolves webpack paths', () => {
      expect(r.apply('webpack:///src/index.ts')).to.equal(
        path.join('${workspaceFolder}/src/index.ts'),
      );
    });

    it('replaces webpack namespaces', () => {
      expect(r.apply('webpack://lib/src/index.ts')).to.equal(
        path.join('${workspaceFolder}/src/index.ts'),
      );
    });

    it('maps an absolute path on windows', () => {
      expect(r.apply('webpack:///c:/users/connor/hello.ts')).to.equal(
        'c:\\users\\connor\\hello.ts',
      );
    });

    it('maps an absolute path on unix', () => {
      expect(r.apply('webpack:////users/connor/hello.ts')).to.equal('/users/connor/hello.ts');
    });
  });
});
