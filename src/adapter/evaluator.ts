/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { generate } from 'astring';
import { randomBytes } from 'crypto';
import { replace } from 'estraverse';
import { ConditionalExpression } from 'estree';
import { inject, injectable } from 'inversify';
import Cdp from '../cdp/api';
import { ICdpApi } from '../cdp/connection';
import { parseProgram } from '../common/sourceCodeManipulations';
import { getSourceSuffix } from './templates';

export const returnValueStr = '$returnValue';

const hoistedPrefix = '__js_debug_hoisted_';

const makeHoistedName = () => hoistedPrefix + randomBytes(8).toString('hex');

export const IEvaluator = Symbol('IEvaluator');

/**
 * Prepared call that can be invoked later on a callframe..
 */
export type PreparedCallFrameExpr = (
  params: Omit<Cdp.Debugger.EvaluateOnCallFrameParams, 'expression'>,
  hoisted?: { [key: string]: Cdp.Runtime.RemoteObject },
) => Promise<Cdp.Debugger.EvaluateOnCallFrameResult | undefined>;

/**
 * Evaluation wraps CDP evaluation requests with additional functionality.
 */
export interface IEvaluator {
  /**
   * Prepares an expression for later evaluation. Returns whether the
   * expression could be run immediately against Chrome without passing through
   * the evaluator, and an "invoke" used to call the function.
   *
   * The "canEvaluate" flag is used in logpoint breakpoints to determine
   * whether we actually need to pause for a custom log evaluation, or whether
   * we can just send the logpoint as the breakpoint condition directly.
   */
  prepare(
    expression: string,
    options?: IPrepareOptions,
  ): { canEvaluateDirectly: boolean; invoke: PreparedCallFrameExpr };

  /**
   * Evaluates the expression on a call frame. This allows
   * referencing the $returnValue
   */
  evaluate(
    params: Cdp.Debugger.EvaluateOnCallFrameParams,
    options?: IEvaluateOptions,
  ): Promise<Cdp.Debugger.EvaluateOnCallFrameResult>;

  /**
   * Evaluates the expression the runtime.
   */
  evaluate(
    params: Cdp.Runtime.EvaluateParams,
    options?: IEvaluateOptions,
  ): Promise<Cdp.Runtime.EvaluateResult>;

  /**
   * Evaluates the expression the runtime or call frame.
   */
  evaluate(
    params: Cdp.Runtime.EvaluateParams | Cdp.Debugger.EvaluateOnCallFrameParams,
    options?: IEvaluateOptions,
  ): Promise<Cdp.Runtime.EvaluateResult | Cdp.Debugger.EvaluateOnCallFrameResult>;

  /**
   * Sets or unsets the last stackframe returned value.
   */
  setReturnedValue(value?: Cdp.Runtime.RemoteObject): void;

  /**
   * Gets whether a return value is currently set.
   */
  readonly hasReturnValue: boolean;
}

interface IEvaluatorBaseOptions {
  /**
   * Whether the script is 'internal' and should
   * not be shown in the sources directory.
   */
  isInternalScript?: boolean;
}

export interface IPrepareOptions extends IEvaluatorBaseOptions {
  /**
   * Replaces the identifiers in the associated script with references to the
   * given remote objects.
   */
  hoist?: ReadonlyArray<string>;
}

export interface IEvaluateOptions extends IEvaluatorBaseOptions {
  /**
   * Replaces the identifiers in the associated script with references to the
   * given remote objects.
   */
  hoist?: { [key: string]: Cdp.Runtime.RemoteObject };
}

/**
 * Evaluation wraps CDP evaluation requests with additional functionality.
 */
@injectable()
export class Evaluator implements IEvaluator {
  private returnValue: Cdp.Runtime.RemoteObject | undefined;

  /**
   * @inheritdoc
   */
  public get hasReturnValue() {
    return !!this.returnValue;
  }

  constructor(@inject(ICdpApi) private readonly cdp: Cdp.Api) {}

  /**
   * @inheritdoc
   */
  public setReturnedValue(value?: Cdp.Runtime.RemoteObject) {
    this.returnValue = value;
  }

  /**
   * @inheritdoc
   */
  public prepare(
    expression: string,
    options: IPrepareOptions = {},
  ): { canEvaluateDirectly: boolean; invoke: PreparedCallFrameExpr } {
    if (options.isInternalScript) {
      expression += getSourceSuffix();
    }

    // CDP gives us a way to evaluate a function in the context of a given
    // object ID. What we do to make returnValue work is to hoist the return
    // object onto `globalThis`, replace reference in the expression, then
    // evalute the expression and unhoist it from the globals.
    const toHoist = new Map<string, string>();
    toHoist.set(returnValueStr, makeHoistedName());
    for (const key of options.hoist ?? []) {
      toHoist.set(key, makeHoistedName());
    }

    const { transformed, hoisted } = this.replaceVariableInExpression(expression, toHoist);
    if (!hoisted.size) {
      return {
        canEvaluateDirectly: true,
        invoke: params => this.cdp.Debugger.evaluateOnCallFrame({ ...params, expression }),
      };
    }

    return {
      canEvaluateDirectly: false,
      invoke: (params, hoistMap = {}) =>
        Promise.all(
          [...toHoist].map(([ident, hoisted]) =>
            this.hoistValue(ident === returnValueStr ? this.returnValue : hoistMap[ident], hoisted),
          ),
        ).then(() => this.cdp.Debugger.evaluateOnCallFrame({ ...params, expression: transformed })),
    };
  }

  /**
   * @inheritdoc
   */
  public evaluate(
    params: Cdp.Debugger.EvaluateOnCallFrameParams,
  ): Promise<Cdp.Debugger.EvaluateOnCallFrameResult>;
  public evaluate(
    params: Cdp.Runtime.EvaluateParams,
    options?: IPrepareOptions,
  ): Promise<Cdp.Runtime.EvaluateResult>;
  public async evaluate(
    params: Cdp.Debugger.EvaluateOnCallFrameParams | Cdp.Runtime.EvaluateParams,
    options?: IPrepareOptions,
  ) {
    // no call frame means there will not be any relevant $returnValue to reference
    if (!('callFrameId' in params)) {
      return this.cdp.Runtime.evaluate(params);
    }

    return this.prepare(params.expression, options).invoke(params);
  }

  /**
   * Hoists the return value of the expression to the `globalThis`.
   */
  public async hoistValue(object: Cdp.Runtime.RemoteObject | undefined, hoistedVar: string) {
    const objectId = object?.objectId;
    const dehoist = `setTimeout(() => { delete globalThis.${hoistedVar} }, 0)`;

    if (objectId) {
      await this.cdp.Runtime.callFunctionOn({
        objectId,
        functionDeclaration: `function() { globalThis.${hoistedVar} = this; ${dehoist}; ${getSourceSuffix()} }`,
      });
    } else {
      await this.cdp.Runtime.evaluate({
        expression:
          `globalThis.${hoistedVar} = ${JSON.stringify(object?.value)};` +
          `${dehoist};` +
          getSourceSuffix(),
      });
    }
  }

  /**
   * Replaces a variable in the given expression with the `hoisted` variable,
   * returning the identifiers which were hoisted.
   */
  private replaceVariableInExpression(
    expr: string,
    hoistMap: Map<string /* identifier */, string /* hoised */>,
  ): { hoisted: Set<string>; transformed: string } {
    const hoisted = new Set<string>();
    const replacement = (name: string): ConditionalExpression => ({
      type: 'ConditionalExpression',
      test: {
        type: 'BinaryExpression',
        left: {
          type: 'UnaryExpression',
          operator: 'typeof',
          prefix: true,
          argument: { type: 'Identifier', name },
        },
        operator: '!==',
        right: { type: 'Literal', value: 'undefined' },
      },
      consequent: { type: 'Identifier', name },
      alternate: {
        type: 'Identifier',
        name: 'undefined',
      },
    });

    const transformed = replace(parseProgram(expr), {
      enter: node => {
        if (node.type === 'Identifier' && hoistMap.has(node.name)) {
          hoisted.add(node.name);
          return replacement(hoistMap.get(node.name) as string);
        }
      },
    });

    return { hoisted, transformed: hoisted.size ? generate(transformed) : expr };
  }
}
