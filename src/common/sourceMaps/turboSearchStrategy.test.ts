/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { FileGlobList } from '../fileGlobList';
import { Logger } from '../logging/logger';
import { TurboSearchStrategy } from './turboSearchStrategy';

describe('TurboSearchStrategy', () => {
  let rootPath: string;

  beforeEach(() => {
    rootPath = mkdtempSync(join(tmpdir(), 'turbo-search-'));
    for (const dir of ['dist', '.nuxt']) {
      mkdirSync(join(rootPath, dir));
      writeFileSync(join(rootPath, dir, `${dir.slice(-4)}.js`), '');
    }
  });

  afterEach(() => rmSync(rootPath, { recursive: true, force: true }));

  const search = (pattern: string) =>
    new TurboSearchStrategy(Logger.null)
      .streamAllChildren(new FileGlobList({ rootPath, patterns: [pattern] }), basename)
      .then(files => files.sort());

  it('searches every brace alternative, including hidden folders', async () => {
    expect(await search('{dist,.nuxt}/**/*.js')).to.deep.equal(['dist.js', 'nuxt.js']);
  });

  it('skips brace alternatives that do not exist', async () => {
    expect(await search('{dist,build}/**/*.js')).to.deep.equal(['dist.js']);
    expect(await search('{dist,build}/dist.js')).to.deep.equal(['dist.js']);
  });
});
