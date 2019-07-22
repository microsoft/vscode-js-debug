/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as beautify from 'js-beautify';
import * as sourceMap from 'source-map';
import * as ts from 'typescript';

type SourceMapConsumer = sourceMap.BasicSourceMapConsumer | sourceMap.IndexedSourceMapConsumer;

export function prettyPrintAsSourceMap(fileName: string, minified: string): Promise<SourceMapConsumer | undefined> {
  const source = beautify(minified);
  const from = generatePositions(source);
  const to = generatePositions(minified);
  if (from.length !== to.length)
    return Promise.resolve(undefined);

  const generator = new sourceMap.SourceMapGenerator();
  generator.setSourceContent(fileName, source);

  // We know that AST for both sources is the same, so we can
  // walk them together to generate mapping.
  for (let i = 0; i < from.length; i += 2) {
    generator.addMapping({
      source: fileName,
      original: { line: from[i], column: from[i + 1] },
      generated: { line: to[i], column: to[i + 1] }
    });
  }
  return sourceMap.SourceMapConsumer.fromSourceMap(generator);
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