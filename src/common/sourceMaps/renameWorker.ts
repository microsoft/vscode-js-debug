/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Node, SourceLocation } from 'estree';
import { isMainThread, parentPort, workerData } from 'worker_threads';
import { parseProgram, traverse } from '../sourceCodeManipulations';
import type { FlatTree } from './renameScopeTree';

type TypeWithChildren = { children?: TypeWithChildren[] };

/**
 * Gets ranges of scopes in the source code. It returns ranges where variables
 * declared in those ranges apply to all child scopes. For example,
 * `function(foo) { bar(); }` emits `(foo) { bar(); }` as a range.
 */
export function extractScopeRangesWithFactory<T extends TypeWithChildren>(
  source: string,
  factory: (start: SourceLocation, end: SourceLocation) => T,
) {
  const program = parseProgram(source);

  const push = (
    indexingNode: Node,
    { loc: start }: Node = indexingNode,
    { loc: end }: Node = indexingNode,
  ) => {
    if (!start || !end) {
      throw new Error('should include locations');
    }

    const next = factory(start, end);
    if (stack.length > 0) {
      const parent = stack[stack.length - 1];
      parent.scopeNode.children ??= [];
      parent.scopeNode.children.push(next);
    }

    stack.push({ node: indexingNode, scopeNode: next });
  };

  // nodes ignored because they're already captured in the top
  // level statement, such as the body of `for` loops.
  const coveredBlocks = new Set<Node>();

  const stack: { node: Node; scopeNode: T }[] = [];
  let programScope: T | undefined;

  traverse(program, {
    enter: node => {
      switch (node.type) {
        // include from the first param to catch function names:
        case 'FunctionDeclaration':
        case 'ArrowFunctionExpression':
          push(node, node.params[0] || node.body, node.body);
          coveredBlocks.add(node.body);
          break;
        // include the top level program:
        case 'Program':
          push(node);
          programScope = stack[0].scopeNode;
          break;
        // include the entire loop to handle declarations inside the statement:
        case 'ForStatement':
        case 'ForOfStatement':
        case 'ForInStatement':
          push(node);
          coveredBlocks.add(node.body);
          break;
        // everything else is captured with block statements:
        case 'BlockStatement':
          if (!coveredBlocks.has(node)) {
            push(node);
          }
          break;
      }
    },
    leave: node => {
      if (node === stack[stack.length - 1].node) {
        stack.pop();
      }
    },
  });

  return programScope as T;
}

if (!isMainThread) {
  parentPort?.postMessage(
    extractScopeRangesWithFactory<FlatTree>(workerData, (start, end) => ({
      start: start.start,
      end: end.end,
    })),
  );
}
