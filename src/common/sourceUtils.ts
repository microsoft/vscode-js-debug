/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as genMap from '@jridgewell/gen-mapping';
import { AnyMap, GREATEST_LOWER_BOUND } from '@jridgewell/trace-mapping';
import { Node as AcornNode, parseExpressionAt, Parser } from 'acorn';
import { generate } from 'astring';
import {
  Expression,
  ExpressionStatement,
  Identifier,
  Node,
  Pattern,
  Program,
  Statement,
} from 'estree';
import { LineColumn } from '../adapter/breakpoints/breakpointBase';
import {
  acornOptions,
  parseProgram,
  replace,
  traverse,
  VisitorOption,
} from './sourceCodeManipulations';
import { NullableGeneratedPosition, SourceMap } from './sourceMaps/sourceMap';

export const enum SourceConstants {
  /**
   * Extension of evaluated sources internal to the debugger. Sources with
   * this suffix will be ignored when displaying sources or stacktracees.
   */
  InternalExtension = '.cdp',

  /**
   * Extension of evaluated REPL source. Stack traces which include frames
   * from this suffix will be truncated to keep only frames from code called
   * by the REPL.
   */
  ReplExtension = '.repl',
}

export async function prettyPrintAsSourceMap(
  fileName: string,
  minified: string,
  compiledPath: string,
  sourceMapUrl: string,
): Promise<SourceMap | undefined> {
  const ast = Parser.parse(minified, { locations: true, ecmaVersion: 'latest' });
  const sourceMap = new genMap.GenMapping({ file: fileName });

  // provide a fake SourceMapGenerator since we want to actually add the
  // *reversed* mappings -- we're creating a fake 'original' source.
  const beautified = generate(ast, {
    sourceMap: {
      addMapping: mapping =>
        genMap.addSegment(
          sourceMap,
          mapping.original.line - 1,
          mapping.original.column,
          fileName,
          mapping.generated.line - 1,
          mapping.generated.column,
        ),
    },
  });

  genMap.setSourceContent(sourceMap, fileName, beautified);

  return new SourceMap(
    new AnyMap(genMap.toDecodedMap(sourceMap)),
    {
      sourceMapUrl,
      compiledPath,
    },
    '',
    [fileName],
    false,
  );
}

export function rewriteTopLevelAwait(code: string): string | undefined {
  let program: Program;
  try {
    // todo: strict needed due to https://github.com/acornjs/acorn/issues/988
    program = parseProgram(code);
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
          return {
            replace: makeAssignment(node.id || { type: 'Identifier', name: '_default' }, {
              ...node,
              type: 'ClassExpression',
            }),
          };
        case 'FunctionDeclaration':
          return {
            replace: makeAssignment(node.id || { type: 'Identifier', name: '_default' }, {
              ...node,
              type: 'FunctionExpression',
            }),
          };
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
  });

  // Top-level return is not allowed.
  if (!containsAwait || containsReturn) {
    return;
  }

  // If we expect the value (last statement is an expression),
  // return it from the inner function.
  const last = program.body[program.body.length - 1];
  if (last.type === 'ExpressionStatement') {
    program.body[program.body.length - 1] = {
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
  return sourceMapUrl.trim();
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
  map: SourceMap,
): NullableGeneratedPosition {
  const prevLocation = map.generatedPositionFor({
    source: sourceUrl,
    line: uiLocation.lineNumber,
    column: uiLocation.columnNumber - 1, // source map columns are 0-indexed
    bias: GREATEST_LOWER_BOUND,
  });

  const getVariance = (position: NullableGeneratedPosition) => {
    if (position.line === null || position.column === null) {
      return 10e10;
    }

    const original = map.originalPositionFor(position);
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
 * Returns if the given node is in a slot reserved for a Pattern where an
 * Expression node could not go.
 */
export const isInPatternSlot = (node: Pattern, parent: Node | null | undefined): boolean =>
  !!parent
  && (((parent.type === 'FunctionExpression'
    || parent.type === 'FunctionDeclaration'
    || parent.type === 'ArrowFunctionExpression')
    && parent.params.includes(node))
    || ((parent.type === 'ForInStatement' || parent.type === 'ForOfStatement')
      && parent.left === node)
    || (parent.type === 'VariableDeclarator' && parent.id === node)
    || (parent.type === 'AssignmentPattern' && parent.left === node)
    || (parent.type === 'CatchClause' && parent.param === node)
    || ('kind' in parent && parent.kind === 'init' && parent.value === node)
    || (parent.type === 'RestElement' && parent.argument === node)
    || (parent.type === 'AssignmentPattern' && parent.left === node));

/**
 * Returns the syntax error in the given code, if any.
 */
export function getSyntaxErrorIn(code: string): Error | void {
  try {
    new Function(code); // CodeQL [SM04509] Function code is never evaluated
  } catch (e) {
    return e;
  }
}

export function getBestSteppableExpressionAt(src: string, offset: number) {
  const ast = parseProgram(src);
  let other: Node | undefined;
  let steppable: Node | undefined;
  traverse(ast, {
    enter: node => {
      const asAcorn = node as AcornNode;
      if (offset >= asAcorn.start && offset < asAcorn.end) {
        if (node.type === 'CallExpression' || node.type === 'NewExpression') {
          steppable = node;
        } else {
          other = node;
        }
      }
    },
  });

  return steppable || other;
}

const notParensRe = /^[^()]+/g;

/**
 * Gets a "step into" target at the given offset in the line of code.
 */
export function getStepTargetInfo(line: string, offset: number) {
  // try being smart by extracting the callable expression
  try {
    const node = getBestSteppableExpressionAt(line, offset);
    if (node && 'callee' in node) {
      const c = node.callee as AcornNode;
      return { text: `${line.slice(c.start, c.end)}(...)`, start: c.start, end: c.end };
    } else {
      const c = node as AcornNode;
      return { text: line.slice(c.start, c.end), start: c.start, end: c.end };
    }
  } catch {
    // ignored
  }

  notParensRe.lastIndex = offset - 1;
  const match = notParensRe.exec(line);
  if (match) {
    return { text: match[0], start: offset, end: offset + match[0].length };
  }

  return undefined;
}
