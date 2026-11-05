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

  it('stops the cwd before a brace segment', () => {
    expect(explode('{dist,build}/**/*.js', '!{dist,build}/vendor/**')).to.deep.equal([
      { cwd, negations: ['{dist,build}/vendor/**'], pattern: '{dist,build}/**/*.js' },
    ]);
  });

  it('keeps braces in a pattern without stars', () => {
    expect(explode('{dist,build}/index.js')).to.deep.equal([
      { cwd, negations: [], pattern: '{dist,build}/index.js' },
    ]);
  });
});
