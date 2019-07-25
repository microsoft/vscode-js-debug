// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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

export function rewriteTopLevelAwait(code: string): string | undefined {
  // Basic idea is to wrap code in async function, which
  // we can await and expose side-effects outside of the function.
  // See "rewriteTopLevelAwait" test for examples.
  code = '(async () => {' + code + '\n})()';
  let body: ts.Block;
  try {
    const sourceFile = ts.createSourceFile(
      'file.js',
      code,
      ts.ScriptTarget.ESNext,
      /*setParentNodes */ true);
    body = sourceFile.statements[0]['expression']['expression']['expression']['body'] as ts.Block;
  } catch(e) {
    return;
  }

  const changes: {start: number, end: number, text: string}[] = [];
  let containsAwait = false;
  let containsReturn = false;

  function traverse(node: ts.Node) {
    switch (node.kind) {
      case ts.SyntaxKind.ClassDeclaration:
        // Expose "class Foo" as "Foo=class Foo"
        const cd = node as ts.ClassDeclaration;
        if (cd.parent === body && cd.name)
          changes.push({text: cd.name.text + '=', start: cd.pos, end: cd.pos});
        break;
      case ts.SyntaxKind.FunctionDeclaration:
        // Expose "function foo(..." as "foo=function foo(..."
        const fd = node as ts.FunctionDeclaration;
        if (fd.name)
          changes.push({text: fd.name.text + '=', start: fd.pos, end: fd.pos});
        return;
      case ts.SyntaxKind.FunctionExpression:
      case ts.SyntaxKind.ArrowFunction:
      case ts.SyntaxKind.MethodDeclaration:
        // Do not recurse into functions.
        return;
      case ts.SyntaxKind.AwaitExpression:
        containsAwait = true;
        break;
      case ts.SyntaxKind.ForOfStatement:
        if ((node as ts.ForOfStatement).awaitModifier)
          containsAwait = true;
        break;
      case ts.SyntaxKind.ReturnStatement:
        containsReturn = true;
        break;
      case ts.SyntaxKind.VariableDeclarationList:
        // Expose "var foo=..." as void(foo=...)
        const vd = node as ts.VariableDeclarationList;

        let s = code.substr(vd.pos);
        let skip = 0;
        while (skip < s.length && /^\s$/.test(s[skip]))
          ++skip;
        s = s.substring(skip);
        const dec = (s.startsWith('const')) ? 'const' : s.substr(0, 3);
        let vdpos = vd.pos + skip;

        if (vd.parent.kind === ts.SyntaxKind.ForOfStatement)
          break;
        if (!vd.declarations.length)
          break;
        if (dec !== 'var') {
          // Do not expose "for (const|let foo".
          if (vd.parent.kind !== ts.SyntaxKind.VariableStatement || vd.parent.parent !== body)
            break;
        }
        const onlyOneDeclaration = vd.declarations.length === 1;
        changes.push({text: onlyOneDeclaration ? 'void' : 'void (', start: vdpos, end: vdpos + dec.length});
        for (const declaration of vd.declarations) {
          if (!declaration.initializer) {
            changes.push({text: '(', start: declaration.pos, end: declaration.pos});
            changes.push({text: '=undefined)', start: declaration.end, end: declaration.end});
            continue;
          }
          changes.push({text: '(', start: declaration.pos, end: declaration.pos});
          changes.push({text: ')', start: declaration.end, end: declaration.end});
        }
        if (!onlyOneDeclaration) {
          const last = vd.declarations[vd.declarations.length - 1];
          changes.push({text: ')', start: last.end, end: last.end});
        }
        break;
    }
    ts.forEachChild(node, traverse);
  }
  traverse(body);

  // Top-level return is not allowed.
  if (!containsAwait || containsReturn)
    return;

  // If we expect the value (last statement is an expression),
  // return it from the inner function.
  const last = body.statements[body.statements.length - 1];
  if (last.kind === ts.SyntaxKind.ExpressionStatement) {
    changes.push({text: 'return (', start: last.pos, end: last.pos});
    if (code[last.end - 1] !== ';')
      changes.push({text: ')', start: last.end, end: last.end});
    else
      changes.push({text: ')', start: last.end - 1, end: last.end - 1});
  }
  while (changes.length) {
    const change = changes.pop()!;
    code = code.substr(0, change.start) + change.text + code.substr(change.end);
  }
  return code;
}
