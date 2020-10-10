/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { parseExpressionAt, Parser } from 'acorn';
import { generate } from 'astring';
import { replace, VisitorOption } from 'estraverse';
import { Expression, ExpressionStatement, Identifier, Program, Statement } from 'estree';
import { promises as fsPromises } from 'fs';
import { NullablePosition, Position, SourceMapConsumer, SourceMapGenerator } from 'source-map';
import { LineColumn } from '../adapter/breakpoints/breakpointBase';
import { LocalFsUtils } from './fsUtils';
import { Hasher } from './hash';
import { isWithinAsar } from './pathUtils';
import { acornOptions, parseProgram } from './sourceCodeManipulations';
import { SourceMap } from './sourceMaps/sourceMap';

export async function prettyPrintAsSourceMap(
  fileName: string,
  minified: string,
  compiledPath: string,
  sourceMapUrl: string,
): Promise<SourceMap | undefined> {
  const ast = Parser.parse(minified, { locations: true, ecmaVersion: 'latest' });
  const sourceMap = new SourceMapGenerator({ file: fileName });

  // provide a fake SourceMapGenerator since we want to actually add the
  // *reversed* mappings -- we're creating a fake 'original' source.
  const beautified = generate(ast, {
    sourceMap: {
      setSourceContent: (file, content) => sourceMap.setSourceContent(file, content),
      applySourceMap: (smc, file, path) => sourceMap.applySourceMap(smc, file, path),
      toJSON: () => sourceMap.toJSON(),
      toString: () => sourceMap.toString(),
      addMapping: mapping =>
        sourceMap.addMapping({
          generated: mapping.original,
          original: { column: mapping.generated.column, line: mapping.generated.line },
          source: fileName,
          name: mapping.name,
        }),
    },
  });

  sourceMap.setSourceContent(fileName, beautified);

  return new SourceMap(
    await SourceMapConsumer.fromSourceMap(sourceMap),
    {
      sourceMapUrl,
      compiledPath,
    },
    '',
    [fileName],
  );
}

export function rewriteTopLevelAwait(code: string): string | undefined {
  let program: Program;
  try {
    // todo: strict needed due to https://github.com/acornjs/acorn/issues/988
    program = parseProgram(code, /* strict= */ true);
  } catch (e) {
    return undefined;
  }

  const makeAssignment = (id: Identifier, rhs: Expression): ExpressionStatement => ({
    type: 'ExpressionStatement',
    expression: {
      type: 'AssignmentExpression',
      operator: '=',
      left: id,
      right: rhs,
    },
  });

  let containsAwait = false;
  let containsReturn = false;

  const replaced = replace(program, {
    enter(node, parent) {
      switch (node.type) {
        case 'ClassDeclaration':
          return makeAssignment(node.id || { type: 'Identifier', name: '_default' }, {
            ...node,
            type: 'ClassExpression',
          });
        case 'FunctionDeclaration':
          this.skip();
          return makeAssignment(node.id || { type: 'Identifier', name: '_default' }, {
            ...node,
            type: 'FunctionExpression',
          });
        case 'FunctionExpression':
        case 'ArrowFunctionExpression':
        case 'MethodDefinition':
          return VisitorOption.Skip;
        case 'AwaitExpression':
          containsAwait = true;
          return;
        case 'ForOfStatement':
          if (node.await) {
            containsAwait = true;
          }
          return;
        case 'ReturnStatement':
          containsReturn = true;
          return;
        case 'VariableDeclaration':
          if (!parent || !('body' in parent) || !(parent.body instanceof Array)) {
            return;
          }

          const stmts = parent.body as Statement[];
          const spliced = node.declarations.map(
            (decl): ExpressionStatement => ({
              type: 'ExpressionStatement',
              expression: {
                type: 'UnaryExpression',
                operator: 'void',
                prefix: true,
                argument: {
                  type: 'AssignmentExpression',
                  operator: '=',
                  left: decl.id,
                  right: decl.init || { type: 'Identifier', name: 'undefined' },
                },
              },
            }),
          );

          stmts.splice(stmts.indexOf(node), 1, ...spliced);
      }
    },
  }) as Program;

  // Top-level return is not allowed.
  if (!containsAwait || containsReturn) {
    return;
  }

  // If we expect the value (last statement is an expression),
  // return it from the inner function.
  const last = replaced.body[replaced.body.length - 1];
  if (last.type === 'ExpressionStatement') {
    replaced.body[replaced.body.length - 1] = {
      type: 'ReturnStatement',
      argument: last.expression,
    };
  }

  const fn: ExpressionStatement = {
    type: 'ExpressionStatement',
    expression: {
      type: 'CallExpression',
      callee: {
        type: 'ArrowFunctionExpression',
        params: [],
        generator: false,
        expression: false,
        async: true,
        body: {
          type: 'BlockStatement',
          body: replaced.body as Statement[],
        },
      },
      arguments: [],
      optional: false,
    },
  };

  return generate(fn);
}

/**
 * If the given code is an object literal expression, like `{ foo: true }`,
 * wraps it with parens like `({ foo: true })`. Will return the input code
 * for other expression or invalid code.
 */
export function wrapObjectLiteral(code: string): string {
  try {
    const expr = parseExpressionAt(code, 0, acornOptions);
    if (expr.end < code.length) {
      return code;
    }

    const cast = expr as Expression;
    if (cast.type !== 'ObjectExpression') {
      return code;
    }

    return `(${code})`;
  } catch {
    return code;
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

const hasher = new Hasher();

export async function checkContentHash(
  absolutePath: string,
  contentHash?: string,
  contentOverride?: string,
): Promise<string | undefined> {
  if (!absolutePath) {
    return undefined;
  }

  if (isWithinAsar(absolutePath)) {
    return undefined;
  }

  if (!contentHash) {
    const exists = await new LocalFsUtils(fsPromises).exists(absolutePath);
    return exists ? absolutePath : undefined;
  }

  const result =
    typeof contentOverride === 'string'
      ? await hasher.verifyBytes(contentOverride, contentHash, true)
      : await hasher.verifyFile(absolutePath, contentHash, true);

  return result ? absolutePath : undefined;
}

export function positionToOffset(text: string, line: number, column: number): number {
  let offset = 0;
  const lines = text.split('\n');
  for (let l = 1; l < line; ++l) offset += lines[l - 1].length + 1;
  offset += column - 1;
  return offset;
}

interface INotNullRange {
  line: number;
  column: number;
  lastColumn: number | null;
}

/**
 * When calling `generatedPositionFor`, we may find non-exact matches. The
 * bias passed to the method controls which of the matches we choose.
 * Here, we will try to pick the position that maps back as closely as
 * possible to the source line if we get an approximate match,
 */
export function getOptimalCompiledPosition(
  sourceUrl: string,
  uiLocation: LineColumn,
  map: SourceMapConsumer,
): NullablePosition {
  const prevLocation = map.generatedPositionFor({
    source: sourceUrl,
    line: uiLocation.lineNumber,
    column: uiLocation.columnNumber - 1, // source map columns are 0-indexed
    bias: SourceMapConsumer.GREATEST_LOWER_BOUND,
  });

  const getVariance = (position: NullablePosition) => {
    if (position.line === null || position.column === null) {
      return 10e10;
    }

    const original = map.originalPositionFor(position as Position);
    return original.line !== null ? Math.abs(uiLocation.lineNumber - original.line) : 10e10;
  };

  const prevVariance = getVariance(prevLocation);

  // allGeneratedLocations similar to a LEAST_UPPER_BOUND, except that it gets
  // all possible locations. From those, we choose the first-best option.
  const allLocations = map
    .allGeneratedPositionsFor({
      source: sourceUrl,
      line: uiLocation.lineNumber,
      column: uiLocation.columnNumber - 1, // source map columns are 0-indexed
    })
    .filter((loc): loc is INotNullRange => loc.line !== null && loc.column !== null)
    .sort((a, b) => (a.line !== b.line ? a.line - b.line : a.column - b.column))
    .map((position): [INotNullRange, number] => [position, getVariance(position)]);

  allLocations.push([prevLocation as INotNullRange, prevVariance]);

  // Sort again--sort is stable (de facto for a while, formalized in ECMA 2019),
  // so we get the first location that has the least variance, or if the variance is the same, the one that appears earliest.
  allLocations.sort(
    ([a, varA], [b, varB]) => varA - varB || a.line - b.line || a.column - b.column,
  );

  return allLocations[0][0];
}

/**
 * Returns the syntax error in the given code, if any.
 */
export function getSyntaxErrorIn(code: string): Error | void {
  try {
    new Function(code);
  } catch (e) {
    return e;
  }
}
