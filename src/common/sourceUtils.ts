// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import beautify from 'js-beautify';
import * as sourceMap from 'source-map';
import * as ts from 'typescript';
import * as urlUtils from './urlUtils';
import * as fsUtils from './fsUtils';
import { calculateHash } from './hash';

export type SourceMapConsumer = sourceMap.BasicSourceMapConsumer | sourceMap.IndexedSourceMapConsumer;

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
    body = (sourceFile.statements[0] as any)['expression']['expression']['expression']['body'] as ts.Block;
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

export function wrapObjectLiteral(code: string): string {
  // Only parenthesize what appears to be an object literal.
  if (!(/^\s*\{/.test(code) && /\}\s*$/.test(code)))
    return code;

  // Function constructor.
  const parse = (async () => 0).constructor;
  try {
    // Check if the code can be interpreted as an expression.
    parse('return ' + code + ';');
    // No syntax error! Does it work parenthesized?
    const wrappedCode = '(' + code + ')';
    parse(wrappedCode);
    return wrappedCode;
  } catch (e) {
    return code;
  }
}

export async function loadSourceMap(url: string, slowDown: number): Promise<SourceMapConsumer | undefined> {
  if (slowDown)
    await new Promise(f => setTimeout(f, slowDown));
  let content = await urlUtils.fetch(url);
  if (content.slice(0, 3) === ')]}')
    content = content.substring(content.indexOf('\n'));
  return await new sourceMap.SourceMapConsumer(content);
}

export function parseSourceMappingUrl(content: string): string | undefined {
  if (!content)
    return;
  const name = 'sourceMappingURL';
  const length = content.length;
  const nameLength = name.length;

  let pos = length;
  let equalSignPos = 0;
  while (true) {
    pos = content.lastIndexOf(name, pos);
    if (pos === -1)
      return;
    // Check for a /\/[\/*][@#][ \t]/ regexp (length of 4) before found name.
    if (pos < 4)
      return;
    pos -= 4;
    if (content[pos] !== '/')
      continue;
    if (content[pos + 1] !== '/')
      continue;
    if (content[pos + 2] !== '#' && content[pos + 2] !== '@')
      continue;
    if (content[pos + 3] !== ' ' && content[pos + 3] !== '\t')
      continue;
    equalSignPos = pos + 4 + nameLength;
    if (equalSignPos < length && content[equalSignPos] !== '=')
      continue;
    break;
  }

  let sourceMapUrl = content.substring(equalSignPos + 1);
  const newLine = sourceMapUrl.indexOf("\n");
  if (newLine !== -1)
    sourceMapUrl = sourceMapUrl.substring(0, newLine);
  sourceMapUrl = sourceMapUrl.trim();
  for (let i = 0; i < sourceMapUrl.length; ++i) {
    if (sourceMapUrl[i] === '"' || sourceMapUrl[i] === '\'' || sourceMapUrl[i] === ' ' || sourceMapUrl[i] === '\t')
      return;
  }
  return sourceMapUrl;
}

export function rewriteLogPoint(code: string): string {
  function text(node: ts.Node) {
    return code.substring(node.pos, node.end);
  }

  let body: ReadonlyArray<ts.Statement>;
  try {
    const sourceFile = ts.createSourceFile(
      'file.js',
      code,
      ts.ScriptTarget.ESNext,
      /*setParentNodes */ true);
    body = sourceFile.statements;
  } catch(e) {
    return `console.log(${code});`;
  }
  if (!body.length) {
    return `console.log(${code});`;
  }

  const last = body[body.length - 1] as ts.Node;
  let logText = `console.log(${text(last)})`;
  if (last.kind === ts.SyntaxKind.ExpressionStatement) {
    const expression = (last as ts.ExpressionStatement).expression;
    if (expression.kind === ts.SyntaxKind.TemplateExpression) {
      const template = expression as ts.TemplateExpression;
      const args: string[] = [];
      const texts: string[] = [];
      texts.push(template.head.text.replace('%', '%%'));
      for (const span of template.templateSpans) {
        texts.push('%O');
        texts.push(span.literal.text.replace('%', '%%'));
        args.push(text(span.expression));
      }
      args.unshift('`' + texts.join('') + '`');
      logText = `console.log(${args.map(s => `(${s})`).join(',')})`;
    }
  }

  return `(function(){${code.substring(0, last.pos)};${logText};return false;})()`;
}

export async function checkContentHash(absolutePath: string, contentHash?: string, contentOverride?: string): Promise<string | undefined> {
  if (!contentHash) {
    const exists = await fsUtils.exists(absolutePath);
    return exists ? absolutePath : undefined;
  }
  const content = (typeof contentOverride === 'string') ? Buffer.from(contentOverride, 'utf8') : await fsUtils.readFileRaw(absolutePath);

  const hash = calculateHash(content);
  return hash === contentHash ? absolutePath : undefined;
}

export function positionToOffset(text: string, line: number, column: number): number {
  let offset = 0;
  const lines = text.split('\n');
  for (let l = 1; l < line; ++l)
    offset += lines[l - 1].length + 1;
  offset += column - 1;
  return offset;
}
