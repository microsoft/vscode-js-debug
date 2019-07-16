/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as ts from 'typescript';
import Dap from '../dap/api';
import Cdp from '../cdp/api';
import {StackFrame} from './stackTrace';

export async function completions(cdp: Cdp.Api, executionContextId: number | undefined, stackFrame: StackFrame | undefined, expression: string, line: number, column: number): Promise<Dap.CompletionItem[]> {
  const sourceFile = ts.createSourceFile(
    'test.js',
    expression,
    ts.ScriptTarget.ESNext,
    /*setParentNodes */ true);

  let prefix;
  let toevaluate;
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
    return (await completePropertyAccess(cdp, executionContextId, stackFrame, toevaluate, prefix)) || [];

  for (const global of ['self', 'this', 'global']) {
    const items = await completePropertyAccess(cdp, executionContextId, stackFrame, global, prefix);
    if (!items)
      continue;

    if (stackFrame) {
      const names = new Set(items.map(item => item.label));
      for (const completion of await stackFrame.completions()) {
        if (names.has(completion.label))
          continue;
        names.add(completion.label);
        items.push(completion);
      }
    }
    return items;
  }
  return [];
}

async function completePropertyAccess(cdp: Cdp.Api, executionContextId: number | undefined, stackFrame: StackFrame | undefined, expression: string, prefix: string): Promise<Dap.CompletionItem[] | undefined> {
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
  };
  const response = (stackFrame && stackFrame.callFrameId())
      ? await cdp.Debugger.evaluateOnCallFrame({...params, callFrameId: stackFrame.callFrameId()!})
      : await cdp.Runtime.evaluate({...params, contextId: executionContextId});
  if (!response || response.exceptionDetails)
    return;

  return response.result.value as Dap.CompletionItem[];
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
