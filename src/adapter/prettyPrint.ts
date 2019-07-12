/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as beautify from 'js-beautify';
import * as sourceMap from 'source-map';
import * as ts from 'typescript';
import { SourceMap } from './sourceMap';

export function prettyPrintAsSourceMap(fileName: string, minified: string): SourceMap | undefined {
  const source = beautify(minified);
  const from = generatePositions(source);
  const to = generatePositions(minified);
  if (from.length !== to.length)
    return;

  const generator = new sourceMap.SourceMapGenerator();
  generator.setSourceContent(fileName, source)

  for (let i = 0; i < from.length; i += 2) {
    if (from[i] === to[i] && from[i + 1] === to[i + 1])
      continue;
    generator.addMapping({
      source: fileName,
      original: { line: from[i], column: from[i + 1] },
      generated: { line: to[i], column: to[i + 1] }
    });
  }
  const result = new SourceMap('', generator.toJSON());
  if (result.errors().length)
    return;
  return result;
}

function generatePositions(text: string) {
  const sourceFile = ts.createSourceFile(
    'file.js',
    text,
    ts.ScriptTarget.ESNext,
    /*setParentNodes */ false);

  const result: number[] = [];
  let index = 0;
  let line = 0;
  let column = 0;
  function traverse(node: ts.Node) {
    for (; index < node.pos; ++index) {
      if (text[index] === '\n') {
        ++line;
        column = 0;
        continue;
      }
      ++column;
    }
    result.push(line + 1, column);
    ts.forEachChild(node, traverse);
  }
  traverse(sourceFile);
  return result;
}