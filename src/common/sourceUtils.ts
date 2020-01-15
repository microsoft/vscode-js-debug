/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import beautify from 'js-beautify';
import * as sourceMap from 'source-map';
import * as ts from 'typescript';
import * as urlUtils from './urlUtils';
import * as fsUtils from './fsUtils';
import { SourceMap, ISourceMapMetadata } from './sourceMaps/sourceMap';
import { logger } from './logging/logger';
import { LogTag } from './logging';
import { hashBytes, hashFile } from './hash';

export async function prettyPrintAsSourceMap(
  fileName: string,
  minified: string,
): Promise<SourceMap | undefined> {
  const source = beautify(minified);
  const from = generatePositions(source);
  const to = generatePositions(minified);
  if (from.length !== to.length) return Promise.resolve(undefined);

  const generator = new sourceMap.SourceMapGenerator();
  generator.setSourceContent(fileName, source);

  // We know that AST for both sources is the same, so we can
  // walk them together to generate mapping.
  for (let i = 0; i < from.length; i += 2) {
    generator.addMapping({
      source: fileName,
      original: { line: from[i], column: from[i + 1] },
      generated: { line: to[i], column: to[i + 1] },
    });
  }
  return new SourceMap(await sourceMap.SourceMapConsumer.fromSourceMap(generator), {
    sourceMapUrl: '',
  });
}

function generatePositions(text: string) {
  const sourceFile = ts.createSourceFile(
    'file.js',
    text,
    ts.ScriptTarget.ESNext,
    /*setParentNodes */ false,
  );

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
      /*setParentNodes */ true,
    );
    // eslint-disable-next-line
    body = (sourceFile.statements[0] as any)['expression']['expression']['expression'][
      'body'
    ] as ts.Block;
  } catch (e) {
    return;
  }

  const changes: { start: number; end: number; text: string }[] = [];
  let containsAwait = false;
  let containsReturn = false;

  function traverse(node: ts.Node) {
    switch (node.kind) {
      case ts.SyntaxKind.ClassDeclaration:
        // Expose "class Foo" as "Foo=class Foo"
        const cd = node as ts.ClassDeclaration;
        if (cd.parent === body && cd.name)
          changes.push({ text: cd.name.text + '=', start: cd.pos, end: cd.pos });
        break;
      case ts.SyntaxKind.FunctionDeclaration:
        // Expose "function foo(..." as "foo=function foo(..."
        const fd = node as ts.FunctionDeclaration;
        if (fd.name) changes.push({ text: fd.name.text + '=', start: fd.pos, end: fd.pos });
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
        if ((node as ts.ForOfStatement).awaitModifier) containsAwait = true;
        break;
      case ts.SyntaxKind.ReturnStatement:
        containsReturn = true;
        break;
      case ts.SyntaxKind.VariableDeclarationList:
        // Expose "var foo=..." as void(foo=...)
        const vd = node as ts.VariableDeclarationList;

        let s = code.substr(vd.pos);
        let skip = 0;
        while (skip < s.length && /^\s$/.test(s[skip])) ++skip;
        s = s.substring(skip);
        const dec = s.startsWith('const') ? 'const' : s.substr(0, 3);
        const vdpos = vd.pos + skip;

        if (vd.parent.kind === ts.SyntaxKind.ForOfStatement) break;
        if (!vd.declarations.length) break;
        if (dec !== 'var') {
          // Do not expose "for (const|let foo".
          if (vd.parent.kind !== ts.SyntaxKind.VariableStatement || vd.parent.parent !== body)
            break;
        }
        const onlyOneDeclaration = vd.declarations.length === 1;
        changes.push({
          text: onlyOneDeclaration ? 'void' : 'void (',
          start: vdpos,
          end: vdpos + dec.length,
        });
        for (const declaration of vd.declarations) {
          if (!declaration.initializer) {
            changes.push({ text: '(', start: declaration.pos, end: declaration.pos });
            changes.push({ text: '=undefined)', start: declaration.end, end: declaration.end });
            continue;
          }
          changes.push({ text: '(', start: declaration.pos, end: declaration.pos });
          changes.push({ text: ')', start: declaration.end, end: declaration.end });
        }
        if (!onlyOneDeclaration) {
          const last = vd.declarations[vd.declarations.length - 1];
          changes.push({ text: ')', start: last.end, end: last.end });
        }
        break;
    }
    ts.forEachChild(node, traverse);
  }
  traverse(body);

  // Top-level return is not allowed.
  if (!containsAwait || containsReturn) return;

  // If we expect the value (last statement is an expression),
  // return it from the inner function.
  const last = body.statements[body.statements.length - 1];
  if (last.kind === ts.SyntaxKind.ExpressionStatement) {
    changes.push({ text: 'return (', start: last.pos, end: last.pos });
    if (code[last.end - 1] !== ';') changes.push({ text: ')', start: last.end, end: last.end });
    else changes.push({ text: ')', start: last.end - 1, end: last.end - 1 });
  }
  for (let i = changes.length - 1; i >= 0; i--) {
    const change = changes[i];
    code = code.substr(0, change.start) + change.text + code.substr(change.end);
  }
  return code;
}

/**
 * If the given code is an object literal expression, like `{ foo: true }`,
 * wraps it with parens like `({ foo: true })`. Will return the input code
 * for other expression or invalid code.
 */
export function wrapObjectLiteral(code: string): string {
  let src: ts.SourceFile;
  try {
    src = ts.createSourceFile('file.js', `return ${code};`, ts.ScriptTarget.ESNext, true);
  } catch {
    return code;
  }
  const returnStmt = src.statements[0];
  if (!ts.isReturnStatement(returnStmt) || !returnStmt.expression) {
    return code; // should never happen, maybe if there's a bizarre parse error
  }

  const diagnostics = ((src as unknown) as { parseDiagnostics?: ts.DiagnosticMessage[] })
    .parseDiagnostics;
  if (diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) {
    return code; // abort on parse errors
  }

  return ts.isObjectLiteralExpression(returnStmt.expression) ? `(${code})` : code;
}

export async function loadSourceMap(
  options: Readonly<Omit<ISourceMapMetadata, 'hash'>>,
): Promise<SourceMap | undefined> {
  let content: string;
  try {
    content = await urlUtils.fetch(options.sourceMapUrl);
  } catch (err) {
    logger.warn(LogTag.SourceMapParsing, 'Error fetching sourcemap', err);
    return;
  }

  if (content.slice(0, 3) === ')]}') {
    content = content.substring(content.indexOf('\n'));
  }

  try {
    return new SourceMap(await new sourceMap.SourceMapConsumer(content), options);
  } catch (err) {
    logger.warn(LogTag.SourceMapParsing, 'Error parsing sourcemap', err);
  }
}

export function parseSourceMappingUrl(content: string): string | undefined {
  if (!content) return;
  const name = 'sourceMappingURL';
  const length = content.length;
  const nameLength = name.length;

  let pos = length;
  let equalSignPos = 0;
  while (true) {
    pos = content.lastIndexOf(name, pos);
    if (pos === -1) return;
    // Check for a /\/[\/*][@#][ \t]/ regexp (length of 4) before found name.
    if (pos < 4) return;
    pos -= 4;
    if (content[pos] !== '/') continue;
    if (content[pos + 1] !== '/') continue;
    if (content[pos + 2] !== '#' && content[pos + 2] !== '@') continue;
    if (content[pos + 3] !== ' ' && content[pos + 3] !== '\t') continue;
    equalSignPos = pos + 4 + nameLength;
    if (equalSignPos < length && content[equalSignPos] !== '=') continue;
    break;
  }

  let sourceMapUrl = content.substring(equalSignPos + 1);
  const newLine = sourceMapUrl.indexOf('\n');
  if (newLine !== -1) sourceMapUrl = sourceMapUrl.substring(0, newLine);
  sourceMapUrl = sourceMapUrl.trim();
  for (let i = 0; i < sourceMapUrl.length; ++i) {
    if (
      sourceMapUrl[i] === '"' ||
      sourceMapUrl[i] === "'" ||
      sourceMapUrl[i] === ' ' ||
      sourceMapUrl[i] === '\t'
    )
      return;
  }
  return sourceMapUrl;
}

const LOGMESSAGE_VARIABLE_REGEXP = /{(.*?)}/g;
export function logMessageToExpression(msg: string): string {
  msg = msg.replace('%', '%%');

  const args: string[] = [];
  let format = msg.replace(LOGMESSAGE_VARIABLE_REGEXP, (_match, group) => {
    const a = group.trim();
    if (a) {
      args.push(`(${a})`);
      return '%O';
    } else {
      return '';
    }
  });

  format = format.replace("'", "\\'");

  const argStr = args.length ? `, ${args.join(', ')}` : '';
  return `console.log('${format}'${argStr});`;
}

export async function checkContentHash(
  absolutePath: string,
  contentHash?: string,
  contentOverride?: string,
): Promise<string | undefined> {
  if (!contentHash) {
    const exists = await fsUtils.exists(absolutePath);
    return exists ? absolutePath : undefined;
  }
  const hash =
    typeof contentOverride === 'string'
      ? await hashBytes(contentOverride)
      : await hashFile(absolutePath);

  return hash === contentHash ? absolutePath : undefined;
}

export function positionToOffset(text: string, line: number, column: number): number {
  let offset = 0;
  const lines = text.split('\n');
  for (let l = 1; l < line; ++l) offset += lines[l - 1].length + 1;
  offset += column - 1;
  return offset;
}

export function pathGlobToBlackboxedRegex(glob: string): string {
  return (
    escapeRegexSpecialChars(glob, '*')
      .replace(/([^*]|^)\*([^*]|$)/g, '$1.*$2') // * -> .*
      .replace(/\*\*(\\\/|\\\\)?/g, '(.*\\/)?') // **/ -> (.*\/)?

      // Just to simplify
      .replace(/\.\*\\\/\.\*/g, '.*') // .*\/.* -> .*
      .replace(/\.\*\.\*/g, '.*') // .*.* -> .*

      // Match either slash direction
      .replace(/\\\/|\\\\/g, '[/\\\\]')
  ); // / -> [/|\], \ -> [/|\]
}

const regexChars = '/\\.?*()^${}|[]+';
export function escapeRegexSpecialChars(str: string, except?: string): string {
  const useRegexChars = regexChars
    .split('')
    .filter(c => !except || except.indexOf(c) < 0)
    .join('')
    .replace(/[\\\]]/g, '\\$&');

  const r = new RegExp(`[${useRegexChars}]`, 'g');
  return str.replace(r, '\\$&');
}
