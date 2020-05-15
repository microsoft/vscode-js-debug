/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Cdp from '../cdp/api';
import * as ts from 'typescript';
import { randomBytes } from 'crypto';
import { inject, injectable } from 'inversify';
import { ICdpApi } from '../cdp/connection';

export const returnValueStr = '$returnValue';

const hoistedPrefix = '__js_debug_hoisted_';

export const IEvaluator = Symbol('IEvaluator');

/**
 * Prepared call that can be invoked later on a callframe..
 */
export type PreparedCallFrameExpr = (
  params: Omit<Cdp.Debugger.EvaluateOnCallFrameParams, 'expression'>,
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
  prepare(expression: string): { canEvaluateDirectly: boolean; invoke: PreparedCallFrameExpr };

  /**
   * Evaluates the expression on a call frame. This allows
   * referencing the $returnValue
   */
  evaluate(
    params: Cdp.Debugger.EvaluateOnCallFrameParams,
  ): Promise<Cdp.Debugger.EvaluateOnCallFrameResult>;

  /**
   * Evaluates the expression the runtime.
   */
  evaluate(params: Cdp.Runtime.EvaluateParams): Promise<Cdp.Runtime.EvaluateResult>;

  /**
   * Evaluates the expression the runtime or call frame.
   */
  evaluate(
    params: Cdp.Runtime.EvaluateParams | Cdp.Debugger.EvaluateOnCallFrameParams,
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
  ): { canEvaluateDirectly: boolean; invoke: PreparedCallFrameExpr } {
    // CDP gives us a way to evaluate a function in the context of a given
    // object ID. What we do to make returnValue work is to hoist the return
    // object onto `globalThis`, replace reference in the expression, then
    // evalute the expression and unhoist it from the globals.
    const hoistedVar = hoistedPrefix + randomBytes(8).toString('hex');
    const modified = this.replaceReturnValue(expression, hoistedVar);
    if (!modified) {
      return {
        canEvaluateDirectly: true,
        invoke: params => this.cdp.Debugger.evaluateOnCallFrame({ ...params, expression }),
      };
    }

    return {
      canEvaluateDirectly: false,
      invoke: params =>
        this.hoistReturnValue(hoistedVar).then(() =>
          this.cdp.Debugger.evaluateOnCallFrame({ ...params, expression: modified }),
        ),
    };
  }

  /**
   * @inheritdoc
   */
  public evaluate(
    params: Cdp.Debugger.EvaluateOnCallFrameParams,
  ): Promise<Cdp.Debugger.EvaluateOnCallFrameResult>;
  public evaluate(params: Cdp.Runtime.EvaluateParams): Promise<Cdp.Runtime.EvaluateResult>;
  public async evaluate(
    params: Cdp.Debugger.EvaluateOnCallFrameParams | Cdp.Runtime.EvaluateParams,
  ) {
    // no call frame means there will not be any relevant $returnValue to reference
    if (!('callFrameId' in params)) {
      return this.cdp.Runtime.evaluate(params);
    }

    return this.prepare(params.expression).invoke(params);
  }

  /**
   * Hoists the return value of the expression to the `globalThis`.
   */
  private async hoistReturnValue(hoistedVar: string) {
    const objectId = this.returnValue?.objectId;
    const dehoist = `setTimeout(() => { delete globalThis.${hoistedVar} }, 0)`;

    if (objectId) {
      await this.cdp.Runtime.callFunctionOn({
        objectId,
        functionDeclaration: `function() { globalThis.${hoistedVar} = this; ${dehoist}; }`,
      });
    } else {
      await this.cdp.Runtime.evaluate({
        expression: `
          globalThis.${hoistedVar} = ${JSON.stringify(this.returnValue?.value)};
          ${dehoist};
        `,
      });
    }
  }

  /**
   * Replaces $returnValue in the given expression with the `hoisted` variable,
   * returning the modified expression if it was found.
   */
  private replaceReturnValue(expr: string, hoistedVar: string): string | undefined {
    const sourceFile = ts.createSourceFile(
      'test.js',
      expr,
      ts.ScriptTarget.ESNext,
      /*setParentNodes */ true,
    );

    let adjust = 0;
    let found = false;

    const replacement = `(typeof ${hoistedVar} !== 'undefined' ? ${hoistedVar} : undefined)`;
    const replace = (node: ts.Node) => {
      if (ts.isIdentifier(node) && node.text === returnValueStr) {
        expr = expr.slice(0, node.getStart() + adjust) + replacement + expr.slice(node.getEnd());
        adjust += node.getEnd() - node.getStart() - replacement.length;
        found = true;
      }

      ts.forEachChild(node, replace);
    };

    replace(sourceFile);

    return found ? expr : undefined;
  }
}
