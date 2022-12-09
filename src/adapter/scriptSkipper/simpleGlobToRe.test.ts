/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { simpleGlobsToRe } from './simpleGlobToRe';

describe('simpleGlobsToRe', () => {
  const truthTable = [
    {
      globs: ['**/foo/**'],
      matches: {
        'file:///hello/foo/bar': true,
        'file:///hello/baz/bar': false,
      },
    },
    {
      globs: ['**/fo$^o/**', '!**/fo$^o/bar/**'],
      matches: {
        'file:///hello/fo$^o/bin/baz': true,
        'file:///hello/fo$^o/bar/baz': false,
      },
    },
    {
      globs: ['**/foo.js'],
      matches: {
        'foo.js': true,
        'file:///hello/foo.js': true,
        'file:///hello/foo.js/bar': false,
      },
    },
    {
      globs: ['**/foo/**', '!**/foo/bar/**'],
      matches: {
        'file:///hello/foo/bin/baz': true,
        'file:///hello/foo/bar/baz': false,
      },
    },
    {
      globs: ['**/foo/**', '!**/foo/bar/**', '**/other/**', '!**/filename.js'],
      matches: {
        'file:///hello/foo/bin/baz': true,
        'file:///hello/foo/bar/baz': false,
        'file:///other/thing': true,
        'file:///other/filename.js': false,
        'file:///hello/foo/bin/filename.js': false,
      },
    },
  ];

  for (const { globs, matches } of truthTable) {
    it(globs.join(', '), () => {
      const res = simpleGlobsToRe(globs);
      for (const [url, expected] of Object.entries(matches)) {
        const matching = res.find(re => re.test(url));
        if (expected !== !!matching) {
          if (expected) {
            throw new Error(`Expected ${url} to match ${res.join(', or')}`);
          } else {
            throw new Error(`Expected ${url} to not match, but ${matching} did`);
          }
        }
      }
    });

    it(`is not catastrophic: ${globs.join(', ')}`, () => {
      const testStr =
        'file:///users/connor/github/vscode-remotehub/common/node_modules/%40opentelemetry/api/build/esm/trace/internal/../../../../src/trace/internal/tracestate-validators.ts';
      const res = simpleGlobsToRe(globs);

      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        for (const re of res) {
          re.test(testStr);
        }
      }

      expect(performance.now() - start).to.be.lessThan(500);
    });
  }
});
