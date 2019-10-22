/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

 import { SourcePathResolver } from '../common/sourcePathResolver';
import { escapeRegexSpecialChars } from '../common/stringUtils';
import { properJoin } from '../common/pathUtils';

export interface ISourcePathResolverOptions {
  sourceMapOverrides: { [key: string]: string };
}

export abstract class SourcePathResolverBase<T extends ISourcePathResolverOptions> implements SourcePathResolver {
  constructor(protected readonly options: T) {}

  public abstract urlToAbsolutePath(url: string): string;

  public abstract absolutePathToUrl(absolutePath: string): string | undefined;

  protected applyPathOverrides(sourcePath: string) {
    const { sourceMapOverrides } = this.options;
    const forwardSlashSourcePath = sourcePath.replace(/\\/g, '/');

    // Sort the overrides by length, large to small
    const sortedOverrideKeys = Object.keys(sourceMapOverrides).sort(
      (a, b) => b.length - a.length,
    );

    // Iterate the key/vals, only apply the first one that matches.
    for (let leftPattern of sortedOverrideKeys) {
      const rightPattern = sourceMapOverrides[leftPattern];
      // const entryStr = `"${leftPattern}": "${rightPattern}"`;

      const asterisks = leftPattern.match(/\*/g) || [];
      if (asterisks.length > 1) {
        // todo: #34
        // logger.log(`Warning: only one asterisk allowed in a sourceMapPathOverrides entry - ${entryStr}`);
        continue;
      }

      const replacePatternAsterisks = rightPattern.match(/\*/g) || [];
      if (replacePatternAsterisks.length > asterisks.length) {
        // todo: #34
        // logger.log(`Warning: the right side of a sourceMapPathOverrides entry must have 0 or 1 asterisks - ${entryStr}}`);
        continue;
      }

      // Does it match?
      const escapedLeftPattern = escapeRegexSpecialChars(leftPattern, '/*');
      const leftRegexSegment = escapedLeftPattern.replace(/\*/g, '(.*)').replace(/\\\\/g, '/');
      const leftRegex = new RegExp(`^${leftRegexSegment}$`, 'i');
      const overridePatternMatches = forwardSlashSourcePath.match(leftRegex);
      if (!overridePatternMatches) continue;

      // Grab the value of the wildcard from the match above, replace the wildcard in the
      // replacement pattern, and return the result.
      const wildcardValue = overridePatternMatches[1];
      let mappedPath = rightPattern.replace(/\*/g, wildcardValue);

      // todo: #34
      // logger.log(`SourceMap: mapping ${sourcePath} => ${mappedPath}, via sourceMapPathOverrides entry - ${entryStr}`);
      return properJoin(mappedPath);
    }

    return sourcePath;
  }
}
