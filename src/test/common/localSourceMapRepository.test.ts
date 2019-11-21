/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { LocalSourceMapRepository } from '../../common/sourceMaps/sourceMapRepository';
import { join } from 'path';
import { createFileTree, testFixturesDir } from '../test';
import { absolutePathToFileUrl } from '../../common/urlUtils';

describe('localSourceMapRepository', () => {
  let r: LocalSourceMapRepository;
  beforeEach(() => {
    r = new LocalSourceMapRepository();
    createFileTree(testFixturesDir, {
      'a.js': '//# sourceMappingURL=a.js.map',
      'a.js.map': 'content1',
      'c.js': 'no.sourcemap.here',
      nested: {
        'd.js': '//# sourceMappingURL=d.js.map',
        'd.js.map': 'content2',
      },
      node_modules: {
        'e.js': '//# sourceMappingURL=e.js.map',
        'e.js.map': 'content3',
      },
    });
  });

  it('no-ops for non-existent directories', async () => {
    expect(await r.findAllChildren(join(__dirname, 'does-not-exist'))).to.be.empty;
  });

  it('discovers all children and skips node_modules', async () => {
    expect(await r.findAllChildren(testFixturesDir)).to.deep.equal({
      [join(testFixturesDir, 'a.js')]: {
        compiledPath: join(testFixturesDir, 'a.js'),
        sourceMapUrl: absolutePathToFileUrl(join(testFixturesDir, 'a.js.map')),
      },
      [join(testFixturesDir, 'nested', 'd.js')]: {
        compiledPath: join(testFixturesDir, 'nested', 'd.js'),
        sourceMapUrl: absolutePathToFileUrl(join(testFixturesDir, 'nested', 'd.js.map')),
      },
    });
  });

  it('looks in node_modules if required', async () => {
    expect(await r.findAllChildren(join(testFixturesDir, 'node_modules'))).to.deep.equal({
      [join(testFixturesDir, 'node_modules', 'e.js')]: {
        compiledPath: join(testFixturesDir, 'node_modules', 'e.js'),
        sourceMapUrl: absolutePathToFileUrl(join(testFixturesDir, 'node_modules', 'e.js.map')),
      },
    });
  });

  // We don't normalize this any more
  it.skip('normalizes for case insensitivity', async () => {
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      expect(await r.findAllChildren(testFixturesDir.toUpperCase())).to.be.empty;
      return;
    }

    const expected = await r.findAllChildren(testFixturesDir);
    const newInst = new LocalSourceMapRepository();
    expect(await newInst.findAllChildren(testFixturesDir.toUpperCase())).to.deep.equal(expected);
  });
});
