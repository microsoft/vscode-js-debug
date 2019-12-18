/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as ts from 'typescript';
import Dap from '../dap/api';
import Cdp from '../cdp/api';
import { StackFrame } from './stackTrace';
import { positionToOffset } from '../common/sourceUtils';
import { enumeratePropertiesTemplate } from './templates/enumerateProperties';

/**
 * Context in which a completion is being evaluated.
 */
export interface ICompletionContext {
  cdp: Cdp.Api;
  executionContextId: number | undefined;
  stackFrame: StackFrame | undefined;
}

/**
 * A completion expresson to be evaluated.
 */
export interface ICompletionExpression {
  expression: string;
  line: number;
  column: number;
}

interface ICompletionWithSort extends Dap.CompletionItem {
  sortText: string;
}

/**
 * Completion kinds known to VS Code. This isn't formally restricted on the DAP.
 * @see https://github.com/microsoft/vscode/blob/71eb6ad17eaf49a46fd176ca74a083001e17f7de/src/vs/editor/common/modes.ts#L329
 */
export const enum CompletionKind {
  Method = 'method',
  Function = 'function',
  Constructor = 'constructor',
  Field = 'field',
  Variable = 'variable',
  Class = 'class',
  Struct = 'struct',
  Interface = 'interface',
  Module = 'module',
  Property = 'property',
  Event = 'event',
  Operator = 'operator',
  Unit = 'unit',
  Value = 'value',
  Constant = 'constant',
  Enum = 'enum',
  EnumMember = 'enumMember',
  Keyword = 'keyword',
  Snippet = 'snippet',
  Text = 'text',
  Color = 'color',
  File = 'file',
  Reference = 'reference',
  Customcolor = 'customcolor',
  Folder = 'folder',
  Type = 'type',
  TypeParameter = 'typeParameter',
}

/**
 * Tries to infer the completion kind for the given TypeScript node.
 */
const inferCompletionKindForDeclaration = (node: ts.Declaration) => {
  if (ts.isClassLike(node)) {
    return CompletionKind.Class;
  } else if (ts.isMethodDeclaration(node)) {
    return CompletionKind.Method;
  } else if (ts.isConstructorDeclaration(node)) {
    return CompletionKind.Constructor;
  } else if (ts.isPropertyDeclaration(node)) {
    return CompletionKind.Property;
  } else if (ts.isVariableDeclarationList(node)) {
    return CompletionKind.Variable;
  } else if (ts.isVariableDeclaration(node)) {
    return node.initializer && ts.isFunctionLike(node.initializer)
      ? CompletionKind.Function
      : CompletionKind.Variable;
  } else if (ts.isStringLiteral(node)) {
    return CompletionKind.Text;
  } else if (ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) {
    return CompletionKind.Value;
  } else if (ts.isInterfaceDeclaration(node)) {
    return CompletionKind.Interface;
  } else if (ts.isTypeAliasDeclaration(node)) {
    return CompletionKind.Interface;
  } else {
    return undefined;
  }
};

export async function completions(
  options: ICompletionContext & ICompletionExpression,
): Promise<Dap.CompletionItem[]> {
  const sourceFile = ts.createSourceFile(
    'test.js',
    options.expression,
    ts.ScriptTarget.ESNext,
    /*setParentNodes */ true,
  );

  const offset = positionToOffset(options.expression, options.line, options.column);
  let candidate: () => Promise<ICompletionWithSort[]> = () => Promise.resolve([]);

  ts.forEachChild(sourceFile, function traverse(node: ts.Node) {
    if (node.pos < offset && offset <= node.end) {
      if (ts.isIdentifier(node)) {
        candidate = () => identifierCompleter(options, sourceFile, node, offset);
      } else if (ts.isPropertyAccessExpression(node)) {
        candidate = () => propertyAccessCompleter(options, node, offset);
      } else if (ts.isElementAccessExpression(node)) {
        candidate = () => elementAccessCompleter(options, node, offset);
      }
    }

    ts.forEachChild(node, traverse);
  });

  return candidate().then(v => v.sort((a, b) => (a.sortText > b.sortText ? 1 : -1)));
}

const isDeclarationStatement = (node: ts.Node): node is ts.DeclarationStatement => 'name' in node;

/**
 * Completer for a TS element access, via bracket syntax.
 */
const elementAccessCompleter = async (
  options: ICompletionContext,
  node: ts.ElementAccessExpression,
  offset: number,
) => {
  if (!ts.isStringLiteralLike(node.argumentExpression)) {
    // If this is not a string literal, either they're typing a number (where
    // autocompletion would be quite silly) or a complex expression where
    // trying to complete by property name is inappropriate.
    return [];
  }

  const prefix = node.argumentExpression
    .getText()
    .slice(1, offset - node.argumentExpression.getStart());

  const completions = await defaultCompletions(options, prefix);

  // Filter out the array access, adjust replacement ranges
  return completions
    .filter(c => c.sortText !== '~~[')
    .map(item => ({
      ...item,
      text: JSON.stringify(item.text ?? item.label) + ']',
      start: node.argumentExpression.getStart(),
      length: node.argumentExpression.getWidth() + 1,
    }));
};

/**
 * Completer for an arbitrary identifier.
 */
const identifierCompleter = async (
  options: ICompletionContext,
  source: ts.SourceFile,
  node: ts.Identifier,
  offset: number,
) => {
  // Walk through the expression and look for any locally-declared variables or identifiers.
  const localIdentifiers: ICompletionWithSort[] = [];
  ts.forEachChild(source, function transverse(node: ts.Node) {
    if (!isDeclarationStatement(node)) {
      ts.forEachChild(node, transverse);
      return;
    }

    if (node.name && ts.isIdentifier(node.name)) {
      localIdentifiers.push({
        label: node.name.text,
        type: inferCompletionKindForDeclaration(node),
        sortText: node.name.text,
      });
    }
  });

  return [
    ...localIdentifiers,
    ...(await defaultCompletions(options, node.getText().substring(0, offset - node.getStart()))),
  ];
};

/**
 * Completes a property access on an object.
 */
const propertyAccessCompleter = async (
  options: ICompletionContext,
  node: ts.PropertyAccessExpression,
  offset: number,
): Promise<ICompletionWithSort[]> => {
  if (hasSideEffects(node.expression)) {
    return [];
  }

  const { result, isArray } = await completePropertyAccess(
    options.cdp,
    options.executionContextId,
    options.stackFrame,
    node.expression.getText(),
    node.name.text.substring(0, offset - node.name.getStart()),
  );

  if (isArray) {
    const start = node.name.getStart() - 1;
    result.unshift({
      label: '[index]',
      text: '[',
      type: 'property',
      sortText: '~~[',
      start,
      length: 1,
    });
  }

  return result;
};

async function completePropertyAccess(
  cdp: Cdp.Api,
  executionContextId: number | undefined,
  stackFrame: StackFrame | undefined,
  expression: string,
  prefix: string,
  isInGlobalScope = false,
): Promise<{ result: ICompletionWithSort[]; isArray: boolean }> {
  const params = {
    expression: enumeratePropertiesTemplate(
      `(${expression})`,
      JSON.stringify(prefix),
      String(isInGlobalScope),
    ),
    objectGroup: 'console',
    silent: true,
    includeCommandLineAPI: true,
    returnByValue: true,
    // completePropertyAccess has numerous false positive side effects, so we can't use throwOnSideEffect.
  };
  const callFrameId = stackFrame && stackFrame.callFrameId();
  const response = callFrameId
    ? await cdp.Debugger.evaluateOnCallFrame({ ...params, callFrameId })
    : await cdp.Runtime.evaluate({ ...params, contextId: executionContextId });
  if (!response || response.exceptionDetails) {
    return { result: [], isArray: false };
  }

  return response.result.value;
}

function hasSideEffects(node: ts.Node): boolean {
  let result = false;
  traverse(node);

  function traverse(node: ts.Node) {
    if (result) return;
    if (
      node.kind === ts.SyntaxKind.CallExpression ||
      node.kind === ts.SyntaxKind.NewExpression ||
      node.kind === ts.SyntaxKind.DeleteExpression ||
      node.kind === ts.SyntaxKind.ClassExpression
    ) {
      result = true;
      return;
    }
    ts.forEachChild(node, traverse);
  }
  return result;
}

/**
 * Returns completion for globally scoped variables. Used for a fallback
 * if we can't find anything more specific to complete.
 */
async function defaultCompletions(
  options: ICompletionContext,
  prefix = '',
): Promise<ICompletionWithSort[]> {
  for (const global of ['self', 'global', 'this']) {
    const { result: items } = await completePropertyAccess(
      options.cdp,
      options.executionContextId,
      options.stackFrame,
      global,
      prefix,
      true,
    );

    if (!items.length) {
      continue;
    }

    if (options.stackFrame) {
      // When evaluating on a call frame, also autocomplete with scope variables.
      const names = new Set(items.map(item => item.label));
      for (const completion of await options.stackFrame.completions()) {
        if (names.has(completion.label)) continue;
        names.add(completion.label);
        items.push(completion as ICompletionWithSort);
      }
    }

    return items;
  }

  return [];
}
