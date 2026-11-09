/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { resolve } from 'path';
import { FileGlobList } from './fileGlobList';
import { forceForwardSlashes } from './pathUtils';

describe('FileGlobList', () => {
  const rootPath = resolve('/project');
  const cwd = forceForwardSlashes(rootPath);
  const explode = (...patterns: string[]) => [
    ...new FileGlobList({ rootPath, patterns }).explode(),
  ];

  it('stops the cwd before a star segment', () => {
    expect(explode('out/**/*.js')).to.deep.equal([
      { cwd: `${cwd}/out`, negations: [], pattern: '**/*.js' },
    ]);
  });

  it('gives each brace alternative its own search root', () => {
    expect(explode('{dist,build}/**/*.js', '!{dist,build}/vendor/**')).to.deep.equal([
      { cwd: `${cwd}/dist`, negations: ['vendor/**'], pattern: '**/*.js' },
      { cwd: `${cwd}/build`, negations: ['vendor/**'], pattern: '**/*.js' },
    ]);
  });

  it('expands braces in a pattern without stars', () => {
    expect(explode('{dist,build}/index.js')).to.deep.equal([
      { cwd: `${cwd}/dist`, negations: [], pattern: 'index.js' },
      { cwd: `${cwd}/build`, negations: [], pattern: 'index.js' },
    ]);
  });

  it('expands nested and repeated brace sets', () => {
    const cwds = explode('{a,b{1,2}}/{c,d}/**/*.js').map(glob => glob.cwd);
    expect(cwds).to.deep.equal(
      ['a/c', 'a/d', 'b1/c', 'b1/d', 'b2/c', 'b2/d'].map(dir => `${cwd}/${dir}`),
    );
  });

  it('expands braces in the first folder under the root', () => {
    const root = forceForwardSlashes(resolve('/'));
    expect(explode(`${root}{a,b}/out/**/*.js`)).to.deep.equal([
      { cwd: `${root}a/out`, negations: [], pattern: '**/*.js' },
      { cwd: `${root}b/out`, negations: [], pattern: '**/*.js' },
    ]);
  });

  it('keeps a brace pair without a comma as a literal folder', () => {
    expect(explode('{proj}/.build/**/*.js')).to.deep.equal([
      { cwd: `${cwd}/{proj}/.build`, negations: [], pattern: '**/*.js' },
    ]);
  });

  it('keeps explicitly named hidden folders in the search root', () => {
    expect(explode('{dist,.nuxt}/**/*.js').map(glob => glob.cwd)).to.deep.equal([
      `${cwd}/dist`,
      `${cwd}/.nuxt`,
    ]);
  });

  it('expands brace alternatives that contain a slash', () => {
    expect(explode('{dist,packages/foo/dist}/**/*.js').map(glob => glob.cwd)).to.deep.equal([
      `${cwd}/dist`,
      `${cwd}/packages/foo/dist`,
    ]);
    expect(explode('{out,../shared/out}/**/*.js').map(glob => glob.cwd)).to.deep.equal([
      `${cwd}/out`,
      `${forceForwardSlashes(resolve('/shared/out'))}`,
    ]);
  });

  it('expands brace alternatives that contain a star', () => {
    expect(explode('{dist,packages/*/dist}/**/*.js')).to.deep.equal([
      { cwd: `${cwd}/dist`, negations: [], pattern: '**/*.js' },
      { cwd: `${cwd}/packages`, negations: [], pattern: '*/dist/**/*.js' },
    ]);
  });

  it('keeps quotes in the folder names', () => {
    const quoted = forceForwardSlashes(resolve("/tmp/o'neil/proj"));
    const glob = (...patterns: string[]) => [
      ...new FileGlobList({ rootPath: quoted, patterns }).explode(),
    ];
    expect(glob(`${quoted}/out/{a,b}.js`)).to.deep.equal([
      { cwd: `${quoted}/out`, negations: [], pattern: 'a.js' },
      { cwd: `${quoted}/out`, negations: [], pattern: 'b.js' },
    ]);
    expect(glob(`${quoted}/{dist,build}/**/*.js`).map(g => g.cwd)).to.deep.equal([
      `${quoted}/dist`,
      `${quoted}/build`,
    ]);
    expect(glob(`${quoted}/out/*.js`, `!${quoted}/out/{a,b}.js`)).to.deep.equal([
      { cwd: `${quoted}/out`, negations: ['a.js', 'b.js'], pattern: '*.js' },
    ]);
    expect(glob('src/{"a",`b`}/**/*.js').map(g => g.cwd)).to.deep.equal([
      `${quoted}/src/"a"`,
      `${quoted}/src/\`b\``,
    ]);
  });

  it('leaves braces after the first star in the pattern', () => {
    expect(explode('out/**/{a,b}.js')).to.deep.equal([
      { cwd: `${cwd}/out`, negations: [], pattern: '**/{a,b}.js' },
    ]);
  });
});
