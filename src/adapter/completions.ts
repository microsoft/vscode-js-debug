/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as ts from 'typescript';
import Dap from '../dap/api';
import { positionToOffset } from '../utils/urlUtils';
import { EvaluationContext } from './evaluation';

export async function completions(evaluationContext: EvaluationContext, expression: string, line: number, column: number): Promise<Dap.CompletionItem[]> {
  const sourceFile = ts.createSourceFile(
    'test.js',
    expression,
    ts.ScriptTarget.ESNext,
    /*setParentNodes */ true);

  // Find the last expression to autocomplete, in the form of "foo.bar.x|"
  let prefix: string | undefined;
  let toevaluate: string | undefined;
  function traverse(node: ts.Node) {
    if (prefix !== undefined)
      return;
    if (node.pos < offset && offset <= node.end) {
      switch (node.kind) {
        case ts.SyntaxKind.Identifier: {
          prefix = node.getText().substring(0, offset - node.getStart());
          toevaluate = '';
          break;
        }
        case ts.SyntaxKind.PropertyAccessExpression: {
          const pe = node as ts.PropertyAccessExpression;
          if (hasSideEffects(pe.expression))
            break;
          prefix = pe.name.getText().substring(0, offset - pe.name.getStart());
          toevaluate = pe.expression.getText();
          break;
        }
      }
    }
    if (prefix === undefined)
      ts.forEachChild(node, traverse);
  }

  const offset = positionToOffset(expression, line, column);
  traverse(sourceFile);

  if (toevaluate)
    return (await completePropertyAccess(evaluationContext, toevaluate, prefix!)) || [];

  // No object to autocomplete on, fallback to globals.
  for (const global of ['self', 'global', 'this']) {
    const items = await completePropertyAccess(evaluationContext, global, prefix || '');
    if (!items)
      continue;

    // When evaluating on a call frame, also autocomplete with scope variables.
    const names = new Set(items.map(item => item.label));
    for (const completion of await evaluationContext.completions()) {
      if (names.has(completion.label))
        continue;
      names.add(completion.label);
      items.push(completion);
    }
    return items;
  }
  return [];
}

async function completePropertyAccess(evaluationContext: EvaluationContext, expression: string, prefix: string): Promise<Dap.CompletionItem[] | undefined> {
  const params = {
    expression: `
      (() => {
        const result = [];
        const set = new Set();
        for (let object = ${expression}; object; object = object.__proto__) {
          const props = Object.getOwnPropertyNames(object).filter(l => l.startsWith('${prefix}') && !l.match(/\\d/));
          for (const name of props) {
            if (set.has(name))
              continue;
            set.add(name);
            const d = Object.getOwnPropertyDescriptor(object, name);
            const dType = typeof d.value;
            let type = undefined;
            if (dType === 'function')
              type = 'function';
            else
              type = 'property';
            result.push({label: name, type});
          }
        }
        return result;
      })();
    `,
    objectGroup: 'console',
    silent: true,
    includeCommandLineAPI: true,
    returnByValue: true
    // completePropertyAccess has numerous false positive side effects, so we can't use throwOnSideEffect.
  };
  const response = await evaluationContext.evaluate(params);
  if (!response || response.exceptionDetails)
    return;

  return response.result.value as Dap.CompletionItem[];
}

function hasSideEffects(node: ts.Node): boolean {
  let result = false;
  traverse(node);

  function traverse(node: ts.Node) {
    if (result)
      return;
    if (node.kind === ts.SyntaxKind.CallExpression ||
      node.kind === ts.SyntaxKind.NewExpression ||
      node.kind === ts.SyntaxKind.DeleteExpression ||
      node.kind === ts.SyntaxKind.ClassExpression) {
      result = true;
      return;
    }
    ts.forEachChild(node, traverse);
  }
  return result;
}
