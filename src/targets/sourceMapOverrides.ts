/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ILogger, LogTag } from '../common/logging';
import { forceForwardSlashes, properJoin } from '../common/pathUtils';
import { escapeRegexSpecialChars } from '../common/stringUtils';

// Patterns to match against various patterns:
const capturingGroup = '*';
const capturingGroupRe = new RegExp(escapeRegexSpecialChars(capturingGroup), 'g');
const nonCapturingGroup = '?:' + capturingGroup;
const nonCapturingGroupRe = new RegExp(escapeRegexSpecialChars(nonCapturingGroup), 'g');

const occurencesInString = (re: RegExp, str: string) => {
  const matches = str.match(re);
  re.lastIndex = 0;
  return matches ? matches.length : 0;
};

const anyGroupRe = new RegExp(
  `${escapeRegexSpecialChars(nonCapturingGroup)}|${escapeRegexSpecialChars(capturingGroup)}`,
  'g',
);

/**
 * Contains a collection of source map overrides, and can apply those to strings.
 */
export class SourceMapOverrides {
  /**
   * Mapping of regexes to replacement patterns. The regexes should return
   * the value to replace in their first matching group, and the patterns
   * will have their asterisk '*', if any, replaced.
   */
  private readonly replacers: [RegExp, string][] = [];

  constructor(sourceMapOverrides: { [from: string]: string }, private readonly logger: ILogger) {
    // Sort the overrides by length, large to small
    const sortedOverrideKeys = Object.keys(sourceMapOverrides).sort(
      (a, b) => b.replace(nonCapturingGroup, '*').length - a.replace(nonCapturingGroup, '*').length,
    );

    // Iterate the key/vals, only apply the first one that matches.
    for (const leftPatternRaw of sortedOverrideKeys) {
      let rightPattern = sourceMapOverrides[leftPatternRaw];
      if (!rightPattern.includes('*') && /\$[0-9'`&]/.test(rightPattern)) {
        this.replacers.push([new RegExp(`^${leftPatternRaw}$`, 'i'), rightPattern]);
        continue;
      }

      const leftPattern = forceForwardSlashes(leftPatternRaw);
      const entryStr = `"${leftPattern}": "${rightPattern}"`;
      const capturedGroups =
        occurencesInString(capturingGroupRe, leftPattern) -
        occurencesInString(nonCapturingGroupRe, leftPattern);

      if (capturedGroups > 1) {
        logger.warn(
          LogTag.RuntimeSourceMap,
          `Warning: only one asterisk allowed in a sourceMapPathOverrides entry - ${entryStr}`,
        );
        continue;
      }

      if (occurencesInString(capturingGroupRe, rightPattern) > capturedGroups) {
        logger.warn(
          LogTag.RuntimeSourceMap,
          `The right side of a sourceMapPathOverrides entry must have 0 or 1 asterisks - ${entryStr}}`,
        );
        continue;
      }

      let reSource = '^';
      let leftIndex = 0;
      anyGroupRe.lastIndex = 0;

      while (true) {
        const next = anyGroupRe.exec(leftPattern);
        reSource += escapeRegexSpecialChars(leftPattern.slice(leftIndex, next?.index), '/');

        if (!next) {
          break;
        }

        if (next[0] === capturingGroup) {
          reSource += '(.*?)';
        } else {
          reSource += '.*?';
        }

        leftIndex = next.index + next[0].length;
      }

      if (capturedGroups === 0) {
        reSource += `([\\/\\\\].*)?`;
        rightPattern += '*';
      }

      this.replacers.push([
        new RegExp(reSource + '$', 'i'),
        rightPattern.replace(/\$/g, '$$$$').replace(/\*/, '$1'), // CodeQL [SM02383] intentional behavior, bad detection
      ]);
    }
  }

  /**
   * Applies soruce map overrides to the path. The path should should given
   * as a filesystem path, not a URI.
   */
  public apply(sourcePath: string): string {
    const sourcePathWithForwardSlashes = forceForwardSlashes(sourcePath);
    for (const [re, replacement] of this.replacers) {
      const mappedPath = sourcePathWithForwardSlashes.replace(re, replacement);
      if (mappedPath !== sourcePathWithForwardSlashes) {
        this.logger.verbose(
          LogTag.RuntimeSourceMap,
          `SourceMap: mapping ${sourcePath} => ${mappedPath}, via sourceMapPathOverrides entry - ${re.toString()}`,
        );

        return properJoin(mappedPath); // normalization, see #401
      }
    }

    return sourcePath;
  }
}
