/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { escapeRegexSpecialChars } from '../../common/stringUtils';

/**
 * Smashes a list of globs into a list of matching regexes. Only
 * supports basic glob features:
 *
 * - Wildcards (**​/foo/bar and *.js)
 * - Entire negations (!**​/foo/bar)
 *
 * This is used in the scriptSkipper because `Debugger.setBlackboxPatterns`
 * only supports a list of regexes to match again.
 */
export function simpleGlobsToRe(globs: readonly string[], processPart = escapeRegexSpecialChars) {
  const res: string[] = [];
  for (let i = 0; i < globs.length; i++) {
    const g = globs[i];
    if (g.startsWith('!')) {
      // Add each negation as a negative lookahead. This is not the fastest for
      // regex engines to compute, but is far faster than previous approaches...
      const re = globToRe(g.slice(1), processPart);
      for (let i = 0; i < res.length; i++) {
        res[i] = `^(?!${re.slice(1)})${res[i].slice(1)}`;
      }
    } else {
      res.push(globToRe(g, processPart));
    }
  }

  return res.map(re => new RegExp(re, 'i'));
}

/**
 * Simple glob to re implementation. We could use micromatch.makeRe, but that
 * inclues a lot of cruft we don't care about when matching against URLs.
 */
function globToRe(glob: string, processPart = escapeRegexSpecialChars) {
  const parts = glob.split('/');
  const regexParts = [];
  for (let j = 0; j < parts.length; j++) {
    const p = parts[j];
    if (p === '**') {
      if (j === 0) {
        regexParts.push('(.+/)?'); // match start, or any slash preceeding what's next...
      } else if (j === parts.length - 1) {
        // nothing more needed!
      } else {
        regexParts.push('.*/');
      }
    } else {
      if (p.includes('*')) {
        const wildcards = p.split('*');
        regexParts.push(wildcards.map(s => processPart(s)).join('[^\\/]*'));
      } else {
        regexParts.push(processPart(p));
      }

      regexParts.push(j < parts.length - 1 ? '\\/' : '$');
    }
  }

  return `^${regexParts.join('')}`;
}
