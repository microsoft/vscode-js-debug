/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Node as AcornNode } from 'acorn';
import { isDummy } from 'acorn-loose';
import { Identifier, MemberExpression, Node, Program } from 'estree';
import { inject, injectable } from 'inversify';
import Cdp from '../cdp/api';
import { ICdpApi } from '../cdp/connection';
import { IPosition } from '../common/positions';
import {
  getEnd,
  getStart,
  getText,
  parseProgram,
  traverse,
  VisitorOption,
} from '../common/sourceCodeManipulations';
import { PositionToOffset } from '../common/stringUtils';
import Dap from '../dap/api';
import { IEvaluator, returnValueStr } from './evaluator';
import { StackFrame } from './stackTrace';
import { enumerateProperties, enumeratePropertiesTemplate } from './templates/enumerateProperties';

/**
 * Context in which a completion is being evaluated.
 */
export interface ICompletionContext {
  expression: string;
  executionContextId: number | undefined;
  stackFrame: StackFrame | undefined;
}

/**
 * A completion expresson to be evaluated.
 */
export interface ICompletionExpression {
  expression: string;
  position: IPosition;
}

export interface ICompletionWithSort extends Dap.CompletionItem {
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
 * Tries to infer the completion kind for the given Acorn node.
 */
const inferCompletionInfoForDeclaration = (node: Node) => {
  switch (node.type) {
    case 'ClassDeclaration':
    case 'ClassExpression':
      return { type: CompletionKind.Class, id: node.id };
    case 'MethodDefinition':
      return {
        type: node.key?.type === 'Identifier' && node.key.name === 'constructor'
          ? CompletionKind.Constructor
          : CompletionKind.Method,
        id: node.key,
      };
    case 'VariableDeclarator':
      return {
        type:
          node.init?.type === 'FunctionExpression' || node.init?.type === 'ArrowFunctionExpression'
            ? CompletionKind.Function
            : CompletionKind.Variable,
        id: node.id,
      };
  }
};

function maybeHasSideEffects(node: Node): boolean {
  let result = false;
  traverse(node, {
    enter(node) {
      if (
        node.type === 'CallExpression'
        || node.type === 'NewExpression'
        || (node.type === 'UnaryExpression' && node.operator === 'delete')
        || node.type === 'ClassBody'
      ) {
        result = true;
        return VisitorOption.Break;
      }
    },
  });

  return result;
}

export const ICompletions = Symbol('ICompletions');

/**
 * Gets autocompletion results for an expression.
 */
export interface ICompletions {
  completions(options: ICompletionContext & ICompletionExpression): Promise<Dap.CompletionItem[]>;
}

/**
 * Provides REPL completions for the debug session.
 */
@injectable()
export class Completions {
  constructor(
    @inject(IEvaluator) private readonly evaluator: IEvaluator,
    @inject(ICdpApi) private readonly cdp: Cdp.Api,
  ) {}

  public async completions(
    options: ICompletionContext & ICompletionExpression,
  ): Promise<Dap.CompletionItem[]> {
    const source = parseProgram(options.expression);
    const offset = new PositionToOffset(options.expression).convert(options.position);
    let candidate: () => Promise<ICompletionWithSort[]> = () => Promise.resolve([]);

    traverse(source, {
      enter: (node, parent) => {
        const asAcorn = node as AcornNode;
        if (asAcorn.start < offset && offset <= asAcorn.end) {
          if (
            node.type === 'MemberExpression'
            || (node.type === 'Identifier'
              && parent?.type === 'MemberExpression'
              && !parent.computed
              && parent.object !== node)
          ) {
            const memberExpression = node.type === 'MemberExpression'
              ? node
              : (parent as MemberExpression);
            candidate = memberExpression.computed
              ? () => this.elementAccessCompleter(options, memberExpression, offset)
              : () => this.propertyAccessCompleter(options, memberExpression, offset);
          } else if (node.type === 'Identifier') {
            candidate = () => this.identifierCompleter(options, source, node, offset);
          }
          parent = node;
        }
      },
    });

    return candidate().then(v => v.sort((a, b) => (a.sortText > b.sortText ? 1 : -1)));
  }

  /**
   * Completer for a TS element access, via bracket syntax.
   */
  private async elementAccessCompleter(
    options: ICompletionContext,
    node: MemberExpression,
    offset: number,
  ) {
    if (node.property.type !== 'Literal' || typeof node.property.value !== 'string') {
      // If this is not a string literal, either they're typing a number (where
      // autocompletion would be quite silly) or a complex expression where
      // trying to complete by property name is inappropriate.
      return [];
    }

    const prefix = options.expression.slice(getStart(node.property) + 1, offset);
    const completions = await this.defaultCompletions(options, prefix);

    // Filter out the array access, adjust replacement ranges
    return completions
      .filter(c => c.sortText !== '~~[')
      .map(item => ({
        ...item,
        text: JSON.stringify(item.text ?? item.label) + ']',
        start: getStart(node.property),
        length: getEnd(node.property) - getStart(node.property),
      }));
  }

  /**
   * Completer for an arbitrary identifier.
   */
  private async identifierCompleter(
    options: ICompletionContext,
    source: Program,
    node: Identifier,
    offset: number,
  ) {
    // Walk through the expression and look for any locally-declared variables or identifiers.
    const localIdentifiers: ICompletionWithSort[] = [];
    traverse(source, {
      enter(node) {
        const completion = inferCompletionInfoForDeclaration(node);
        if (completion?.id?.type === 'Identifier') {
          localIdentifiers.push({
            label: completion.id.name,
            type: completion.type,
            sortText: completion.id.name,
          });
        }
      },
    });

    const prefix = options.expression.slice(getStart(node), offset);
    const completions = [
      ...localIdentifiers,
      ...(await this.defaultCompletions(options, prefix)),
    ];

    if (
      this.evaluator.hasReturnValue
      && options.executionContextId !== undefined
      && returnValueStr.startsWith(prefix)
    ) {
      completions.push({
        sortText: `~${returnValueStr}`,
        label: returnValueStr,
        type: 'variable',
      });
    }

    return completions;
  }

  /**
   * Completes a property access on an object.
   */
  async propertyAccessCompleter(
    options: ICompletionContext,
    node: MemberExpression,
    offset: number,
  ): Promise<ICompletionWithSort[]> {
    const { result, isArray } = await this.completePropertyAccess({
      executionContextId: options.executionContextId,
      stackFrame: options.stackFrame,
      expression: getText(options.expression, node.object),
      prefix: isDummy(node.property)
        ? ''
        : options.expression.slice(getStart(node.property), offset),
      // If we see the expression might have a side effect, still try to get
      // completions, but tell V8 to throw if it sees a side effect. This is a
      // fairly conservative checker, we don't enable it if not needed.
      throwOnSideEffect: maybeHasSideEffects(node),
    });

    const start = getStart(node.property) - 1;

    // For any properties are aren't valid identifiers, (erring on the side of
    // caution--not checking unicode and such), quote them as foo['bar!']
    const validIdentifierRe = /^[$a-z_][0-9a-z_$]*$/i;
    for (const item of result) {
      if (!validIdentifierRe.test(item.label)) {
        item.text = `[${JSON.stringify(item.label)}]`;
        item.start = start;
        item.length = 1;
      }
    }

    if (isArray) {
      const placeholder = 'index';
      result.unshift({
        label: `[${placeholder}]`,
        text: `[${placeholder}]`,
        type: 'property',
        sortText: '~~[',
        start,
        selectionStart: 1,
        selectionLength: placeholder.length,
        length: 1,
      });
    }

    return result;
  }

  private async completePropertyAccess({
    executionContextId,
    stackFrame,
    expression,
    prefix,
    isInGlobalScope = false,
    throwOnSideEffect = false,
  }: {
    executionContextId?: number;
    stackFrame?: StackFrame;
    expression: string;
    prefix: string;
    throwOnSideEffect?: boolean;
    isInGlobalScope?: boolean;
  }): Promise<{ result: ICompletionWithSort[]; isArray: boolean }> {
    const params = {
      expression: `(${expression})`,
      objectGroup: 'console',
      silent: true,
      throwOnSideEffect,
    };

    const callFrameId = stackFrame && stackFrame.callFrameId();
    const objRefResult = await this.evaluator.evaluate(
      callFrameId ? { ...params, callFrameId } : { ...params, contextId: executionContextId },
      { stackFrame },
    );

    if (!objRefResult || objRefResult.exceptionDetails) {
      return { result: [], isArray: false };
    }

    // No object ID indicates a primitive. Call enumeration on the value
    // directly. We don't do this all the time, since our enumeration logic
    // triggers Chrome's side-effect detect and fails.
    if (!objRefResult.result.objectId) {
      const primitiveParams = {
        ...params,
        returnByValue: true,
        throwOnSideEffect: false,
        expression: enumeratePropertiesTemplate.expr(
          `(${expression})`,
          JSON.stringify(prefix),
          JSON.stringify(isInGlobalScope),
        ),
      };

      const propsResult = await this.evaluator.evaluate(
        callFrameId
          ? { ...primitiveParams, callFrameId }
          : { ...primitiveParams, contextId: executionContextId },
      );

      return !propsResult || propsResult.exceptionDetails
        ? { result: [], isArray: false }
        : propsResult.result.value;
    }

    // Otherwise, invoke the property enumeration on the returned object ID.
    try {
      const propsResult = await enumerateProperties({
        cdp: this.cdp,
        args: [undefined, prefix, isInGlobalScope],
        objectId: objRefResult.result.objectId,
        returnByValue: true,
      });

      return propsResult.value;
    } catch {
      return { result: [], isArray: false };
    } finally {
      this.cdp.Runtime.releaseObject({ objectId: objRefResult.result.objectId }); // no await
    }
  }

  /**
   * Returns completion for globally scoped variables. Used for a fallback
   * if we can't find anything more specific to complete.
   */
  private async defaultCompletions(
    options: ICompletionContext,
    prefix = '',
  ): Promise<ICompletionWithSort[]> {
    for (const global of ['self', 'global', 'this']) {
      const { result: items } = await this.completePropertyAccess({
        executionContextId: options.executionContextId,
        stackFrame: options.stackFrame,
        expression: global,
        prefix,
        isInGlobalScope: true,
      });

      if (options.stackFrame) {
        // When evaluating on a call frame, also autocomplete with scope variables.
        const lowerPrefix = prefix.toLowerCase();
        const names = new Set(items.map(item => item.label));
        for (const completion of await options.stackFrame.completions()) {
          if (
            names.has(completion.label)
            || !completion.label.toLowerCase().includes(lowerPrefix)
          ) {
            continue;
          }

          names.add(completion.label);
          items.push(completion as ICompletionWithSort);
        }
      }

      items.push(...this.syntheticCompletions(options, prefix));

      return items;
    }

    return this.syntheticCompletions(options, prefix);
  }

  private syntheticCompletions(
    _options: ICompletionContext,
    prefix: string,
  ): ICompletionWithSort[] {
    if (this.evaluator.hasReturnValue && returnValueStr.startsWith(prefix)) {
      return [
        {
          sortText: `~${returnValueStr}`,
          label: returnValueStr,
          type: 'variable',
        },
      ];
    }

    return [];
  }
}
