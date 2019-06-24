/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as ts from 'typescript';
import ProtocolProxyApi from 'devtools-protocol/types/protocol-proxy-api';

export async function completions(cdp: ProtocolProxyApi.ProtocolApi, expression: string, line: number, column: number): Promise<string[]> {
  const sourceFile = ts.createSourceFile(
    'test.js',
    expression,
    ts.ScriptTarget.ESNext,
    /*setParentNodes */ true);

  const offset = positionToOffset(expression, line, column);
  let result: Promise<string[]>;
  traverse(sourceFile);

  function traverse(node: ts.Node) {
    if (result)
      return;
    if (node.pos < offset && offset <= node.end) {
      switch (node.kind) {
        case ts.SyntaxKind.Identifier: {
          const prefix = node.getText().substring(0, offset - node.getStart());
          result = completePropertyAccess(cdp, 'self', prefix);
          break;
        }
        case ts.SyntaxKind.PropertyAccessExpression: {
          const pe = node as ts.PropertyAccessExpression;
          if (hasSideEffects(pe.expression))
            break;
          const prefix = pe.name.getText().substring(0, offset - pe.name.getStart());
          result = completePropertyAccess(cdp, pe.expression.getText(), prefix);
          break;
        }
      }
    }

    if (!result)
      ts.forEachChild(node, traverse);
  }
  return result || Promise.resolve([]);
}

async function completePropertyAccess(cdp: ProtocolProxyApi.ProtocolApi, expression: string, prefix: string): Promise<string[]> {
  const response = await cdp.Runtime.evaluate({
    expression: `
      (function() {
        const result = [];
        for (let object = ${expression}; object; object = object.__proto__) {
          const props = Object.getOwnPropertyNames(object).filter(l => l.startsWith('${prefix}'));
          result.push(...props);
        }
        return result;
      })();
    `,
    objectGroup: 'console',
    silent: true,
    returnByValue: true
  });
  if (!response || response.exceptionDetails)
    return [];
  return response.result.value as string[];
}

function positionToOffset(text: string, line: number, column: number): number {
  let offset = 0;
  const lines = text.split('\n');
  for (let l = 1; l < line; ++l)
    offset += lines[l - 1].length + 1;
  offset += column - 1;
  return offset;
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
