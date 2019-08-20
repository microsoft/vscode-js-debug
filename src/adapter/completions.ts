// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as ts from 'typescript';
import Dap from '../dap/api';
import Cdp from '../cdp/api';
import { StackFrame } from './stackTrace';
import { positionToOffset } from '../utils/urlUtils';

export async function completions(cdp: Cdp.Api, executionContextId: number | undefined, stackFrame: StackFrame | undefined, expression: string, line: number, column: number): Promise<Dap.CompletionItem[]> {
  const sourceFile = ts.createSourceFile(
    'test.js',
    expression,
    ts.ScriptTarget.ESNext,
    /*setParentNodes */ true);

  // Find the last expression to autocomplete, in the form of "foo.bar.x|"
  let prefix: string | undefined;
  let toevaluate: string | undefined;
  let quoteBefore = '';
  let quoteAfter = '';
  const offset = positionToOffset(expression, line, column);
  const triggerCharacter = expression[offset - 1];
  let length = 0;

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
        case ts.SyntaxKind.ElementAccessExpression: {
          const ae = node as ts.ElementAccessExpression;
          prefix = ae.argumentExpression.getText().substring(0, offset - ae.argumentExpression.getStart());
          if (prefix.startsWith(`'`) || prefix.startsWith(`"`)) {
            quoteBefore = '[' + prefix[0];
            quoteAfter = prefix[0] + ']';
            prefix = prefix.substr(1);
            length = prefix.length + 2;
          } else if (triggerCharacter === `[`) {
            quoteBefore = `['`;
            quoteAfter = `']`;
            length = 1;
          }
          toevaluate = ae.expression.getText();
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

  traverse(sourceFile);

  if (toevaluate)
    return (await completePropertyAccess(cdp, executionContextId, stackFrame, toevaluate, prefix!, {
      length, quoteBefore, quoteAfter
    })) || [];

  // No object to autocomplete on, fallback to globals.
  for (const global of ['self', 'global', 'this']) {
    const items = await completePropertyAccess(cdp, executionContextId, stackFrame, global, prefix || '', {});
    if (!items)
      continue;

    if (stackFrame) {
      // When evaluating on a call frame, also autocomplete with scope variables.
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

type CompletionOptions = { quoteBefore?: string, quoteAfter?: string, length?: number };

async function completePropertyAccess(cdp: Cdp.Api, executionContextId: number | undefined, stackFrame: StackFrame | undefined, expression: string, prefix: string, options: CompletionOptions): Promise<Dap.CompletionItem[] | undefined> {
  const params = {
    expression: `
      (() => {
        const result = [];
        const set = new Set();
        let prefix = '~';
        for (let object = ${expression}; object; object = object.__proto__) {
          if (object instanceof Array)
            return result;
          prefix += '~';
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
            result.push({label: name, sortText: prefix + name, type});
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
  const response = (stackFrame && stackFrame.callFrameId())
    ? await cdp.Debugger.evaluateOnCallFrame({ ...params, callFrameId: stackFrame.callFrameId()! })
    : await cdp.Runtime.evaluate({ ...params, contextId: executionContextId });
  if (!response || response.exceptionDetails)
    return;

  return response.result.value.map((item: Dap.CompletionItem) => ({
    ...item,
    length: options.length ? options.length : undefined,
    label: (options.quoteBefore || '') + item.label + (options.quoteAfter || '')
  }));
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
