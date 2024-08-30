/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { promises as fs } from 'fs';
import { join } from 'path';
import { spy } from 'sinon';
import { createFileTree, getTestDir } from '../../test/createFileTree';
import { CacheTree } from './cacheTree';
import { IGlobCached, ITurboGlobStreamOptions, TurboGlobStream } from './turboGlobStream';

describe('TurboGlobStream', () => {
  const dir = getTestDir();

  const upperCaseContents = async (fpath: string) => {
    const contents = await fs.readFile(fpath, 'utf8');
    return contents.toUpperCase();
  };

  const doTests = async <T>({
    opts,
    expected,
  }: {
    opts: Omit<ITurboGlobStreamOptions<T>, 'cache' | 'cwd'>;
    expected: T[];
  }) => {
    const cache = CacheTree.root<IGlobCached<T>>();

    // do the test twice so that it verifies the cached result is the same
    for (let i = 0; i < 2; i++) {
      await new Promise((resolve, reject) => {
        const matches: T[] = [];
        const tgs = new TurboGlobStream({
          cwd: dir,
          ...opts,
          cache,
          fileProcessor: (fname, meta) => {
            delete (meta as Record<string, unknown>).mtime; // delete this since it'll change for every test
            return opts.fileProcessor(fname, meta);
          },
        });
        tgs.onError(reject);
        tgs.onFile(result => matches.push(result));
        tgs.done
          .then(() =>
            expect(matches.sort()).to.deep.equal(expected, `bad result in call number ${i + 1}`)
          )
          .then(resolve, reject);
      });
    }

    return cache;
  };

  before(() => {
    createFileTree(dir, {
      a: {
        'a1.js': 'a1',
        'a2.js': 'a2',
      },
      b: {
        'b1.js': 'b1',
        'b2.js': 'b2',
      },
      c: {
        nested: {
          a: {
            'c1.js': 'c1',
          },
        },
      },
    });
  });

  after(async () => {
    await fs.rm(dir, { recursive: true });
  });

  it('globs for singular file', async () => {
    const fileProcessor = spy(upperCaseContents);
    await doTests({
      expected: ['A1'],
      opts: {
        pattern: 'a/a1.js',
        ignore: [],
        fileProcessor,
      },
    });

    expect(fileProcessor.args).to.deep.equal([
      [join(dir, 'a', 'a1.js'), { siblings: ['a1.js', 'a2.js'] }],
    ]);
  });

  it('uses platform preferred path', async () => {
    const expected = join(dir, 'a', 'a1.js');
    await doTests({
      expected: [expected],
      opts: {
        pattern: 'a/a1.js',
        ignore: [],
        fileProcessor: async fpath => {
          expect(fpath).to.equal(expected);
          return fpath;
        },
      },
    });
  });

  it('globs for multiple files in a single dir', async () => {
    const fileProcessor = spy(upperCaseContents);
    await doTests({
      expected: ['A1', 'A2'],
      opts: {
        pattern: 'a/*.js',
        ignore: [],
        fileProcessor,
      },
    });

    expect(fileProcessor.args.slice().sort((a, b) => a[0].localeCompare(b[0]))).to.deep.equal([
      [join(dir, 'a', 'a1.js'), { siblings: ['a1.js', 'a2.js'] }],
      [join(dir, 'a', 'a2.js'), { siblings: ['a1.js', 'a2.js'] }],
    ]);
  });

  it('globs for files recursively', async () => {
    const fileProcessor = spy(upperCaseContents);
    await doTests({
      expected: ['A1', 'A2', 'B1', 'B2', 'C1'],
      opts: {
        pattern: '**/*.js',
        ignore: [],
        fileProcessor,
      },
    });

    expect(fileProcessor.args.slice().sort((a, b) => a[0].localeCompare(b[0]))).to.deep.equal([
      [join(dir, 'a', 'a1.js'), { siblings: ['a1.js', 'a2.js'] }],
      [join(dir, 'a', 'a2.js'), { siblings: ['a1.js', 'a2.js'] }],
      [join(dir, 'b', 'b1.js'), { siblings: ['b1.js', 'b2.js'] }],
      [join(dir, 'b', 'b2.js'), { siblings: ['b1.js', 'b2.js'] }],
      [join(dir, 'c', 'nested', 'a', 'c1.js'), { siblings: ['c1.js'] }],
    ]);
  });

  it('globs star dirname', async () => {
    const fileProcessor = spy(upperCaseContents);
    await doTests({
      expected: ['A1', 'A2', 'C1'],
      opts: {
        pattern: '**/a/**/*.js',
        ignore: [],
        fileProcessor,
      },
    });

    expect(fileProcessor.callCount).to.equal(3);
  });

  it('globs braces', async () => {
    const fileProcessor = spy(upperCaseContents);
    await doTests({
      expected: ['A1', 'A2', 'B1', 'B2'],
      opts: {
        pattern: '{a,b}/**/*.js',
        ignore: [],
        fileProcessor,
      },
    });

    expect(fileProcessor.callCount).to.equal(4);
  });

  it('applies ignores for files', async () => {
    const fileProcessor = spy(upperCaseContents);
    await doTests({
      expected: ['A1', 'B1'],
      opts: {
        pattern: '{a,b}/**/*.js',
        ignore: ['**/*2.js'],
        fileProcessor,
      },
    });

    expect(fileProcessor.callCount).to.equal(2);
  });

  it('works with absolute globs', async () => {
    const fileProcessor = spy(upperCaseContents);
    await doTests({
      expected: ['A1', 'B1'],
      opts: {
        pattern: `${dir}/{a,b}/**/*.js`,
        ignore: [`${dir}/**/*2.js`],
        fileProcessor,
      },
    });

    expect(fileProcessor.callCount).to.equal(2);
  });

  it('applies ignores for dirs', async () => {
    const fileProcessor = spy(upperCaseContents);
    await doTests({
      expected: ['A1', 'A2'],
      opts: {
        pattern: '{a,b}/**/*.js',
        ignore: ['b/*.js'],
        fileProcessor,
      },
    });

    expect(fileProcessor.callCount).to.equal(2);
  });

  it('applies filters currectly', async () => {
    const fileProcessor = spy(upperCaseContents);
    await doTests({
      expected: ['A1'],
      opts: {
        filter: fpath => fpath.endsWith('1.js'),
        pattern: 'a/*.js',
        ignore: [],
        fileProcessor,
      },
    });
  });
});
