/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as ts from 'typescript';

/**
 * Creates a template for the given function that replaces its arguments
 * and generates a string to be executed where it takes expressions to be
 * interpolated in place of arguments.  It assumes there's no shadowing
 * going on and that the template does not reference things outside its scope.
 *
 * This is not pretty, but presented as an alternative to writing a bunch of
 * raw JavaScript functions in strings.
 *
 * Example:
 *
 * ```js
 * const multiply = (a, b) => {
 *   return a * b;
 * };
 * const template = templateFunction(multiply);
 * console.log(multiple('42', 'foo()));
 * ```
 *
 * Outputs:
 *
 * ```
 * (() => {
 *   let __arg0 = 42;
 *   let __arg1 = foo();
 *   return __arg0 * __arg1;
 * })();
 * ```
 */
export function templateFunction<A>(fn: (a: A) => void): (a: string) => string;
export function templateFunction<A, B>(fn: (a: A, b: B) => void): (a: string, b: string) => string;
export function templateFunction<A, B, C>(
  fn: (a: A, b: B, c: C) => void,
): (a: string, b: string, c: string) => string;
export function templateFunction<Args extends unknown[]>(
  fn: (...args: Args) => void,
): (...args: string[]) => string {
  const stringified = '' + fn;
  const sourceFile = ts.createSourceFile('test.js', stringified, ts.ScriptTarget.ESNext, true);

  // 1. Find the function.
  let decl: ts.FunctionLike | undefined;
  ts.forEachChild(sourceFile, function traverse(node) {
    if (ts.isFunctionLike(node)) {
      decl = node;
    } else {
      ts.forEachChild(node, traverse);
    }
  });

  if (!decl || !('body' in decl) || !decl.body) {
    throw new Error(`Could not find function declaration for ${fn}`);
  }

  // 2. Get parameter names.
  const params = decl.parameters.map(p => {
    if (!ts.isIdentifier(p.name)) {
      throw new Error('Parameter must be identifier');
    }

    return p.name.text;
  });

  // 3. Gather usages of the parameter in the source.
  const replacements: { start: number; end: number; param: number }[] = [];
  ts.forEachChild(decl.body, function traverse(node) {
    if (ts.isIdentifier(node) && params.includes(node.text)) {
      replacements.push({
        start: node.getStart(),
        end: node.getEnd(),
        param: params.indexOf(node.text),
      });
    }

    ts.forEachChild(node, traverse);
  });

  replacements.sort((a, b) => b.end - a.end);

  // 4. Sort usages and slice up the function appropriately, wraping in an IIFE.
  const parts: string[] = [];
  let lastIndex = decl.body.getEnd() - 1;
  for (const replacement of replacements) {
    parts.push(stringified.slice(replacement.end, lastIndex));
    parts.push(`__args${replacement.param}`);
    lastIndex = replacement.start;
  }

  parts.push(stringified.slice(decl.body.getStart() + 1, lastIndex));
  const body = parts.reverse().join('');

  return (...args) => `(() => {
    ${args.map((a, i) => `let __args${i} = ${a}`).join('; ')};
    ${body}
  })();`;
}
