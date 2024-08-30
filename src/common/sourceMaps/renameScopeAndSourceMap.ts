/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Base0Position } from '../positions';
import { PositionToOffset } from '../stringUtils';
import { IRename } from './renameProvider';
import { extractScopeRanges, ScopeNode } from './renameScopeTree';
import { SourceMap } from './sourceMap';

enum Constant {
  SourceMapNameIndex = 4,
}

/** Very approximate regex for JS identifiers */
const identifierRe = /[$a-z_][$0-9A-Z_$]*/iy;

export const extractScopeRenames = async (source: string, sourceMap: SourceMap) => {
  const toOffset = new PositionToOffset(source);

  /**
   * Parsed mappings to their rename data, or undefined if the rename was
   * not valid or was already included in a scope.
   */
  const usedMappings = new Set<number>();
  const decodedMappings = sourceMap.decodedMappings();
  const decodedNames = sourceMap.names();

  const getNameFromMapping = (
    generatedLineBase0: number,
    generatedColumnBase0: number,
    originalName: string,
  ) => {
    // keep things as numbers for performance: number in upper bits (until MAX_SAFE_INTEGER),
    // column in lower 32 bits.
    const cacheKey = (generatedLineBase0 * 0x7fffffff) | generatedColumnBase0;
    if (usedMappings.has(cacheKey)) {
      return undefined;
    }

    // always say we used this mapping, since trying again would be useless:
    usedMappings.add(cacheKey);

    const position = new Base0Position(generatedLineBase0, generatedColumnBase0);
    const start = toOffset.convert(position);
    identifierRe.lastIndex = start;
    const match = identifierRe.exec(source);
    if (!match) {
      return;
    }

    const compiled = match[0];
    if (compiled === originalName) {
      return; // it happens sometimes 🤷
    }

    return compiled;
  };

  const extract = (node: ScopeNode<IRename[]>): IRename[] | undefined => {
    const start = node.range.begin.base0;
    const end = node.range.end.base0;
    let renames: IRename[] | undefined;
    // Reference: https://github.com/jridgewell/trace-mapping/blob/5a658b10d9b6dea9c614ff545ca9c4df895fee9e/src/trace-mapping.ts#L258-L290
    for (let i = start.lineNumber; i <= end.lineNumber; i++) {
      const mappings = decodedMappings[i];
      if (!mappings) {
        continue;
      }
      for (let k = 0; k < mappings.length; k++) {
        const mapping: number[] = mappings[k];
        if (mapping.length <= Constant.SourceMapNameIndex) {
          continue;
        }

        const generatedLineBase0 = i;
        const generatedColumnBase0 = mapping[0];
        if (
          generatedLineBase0 === node.range.begin.base0.lineNumber
          && node.range.begin.base0.columnNumber > generatedColumnBase0
        ) {
          continue;
        }
        if (
          generatedLineBase0 === node.range.end.base0.lineNumber
          && node.range.end.base0.columnNumber < generatedColumnBase0
        ) {
          continue;
        }

        const originalName = decodedNames[mapping[4]];
        const compiledName = getNameFromMapping(
          generatedLineBase0,
          generatedColumnBase0,
          originalName,
        );
        if (!compiledName) {
          continue;
        }

        renames ??= [];

        // some tools emit name mapping each time the identifier is used, avoid duplicates.
        if (!renames.some(r => r.compiled == compiledName)) {
          renames.push({ compiled: compiledName, original: originalName });
        }
      }
    }

    return renames;
  };

  const scopeTree = await extractScopeRanges(source, extract);

  scopeTree.filterHoist(node => !!node.data);

  return scopeTree;
};
