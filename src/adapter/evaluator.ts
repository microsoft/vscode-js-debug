/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Node as AcornNode } from 'acorn';
import { generate } from 'astring';
import { randomBytes } from 'crypto';
import { ConditionalExpression, Expression } from 'estree';
import { inject, injectable } from 'inversify';
import Cdp from '../cdp/api';
import { ICdpApi } from '../cdp/connection';
import { ILogger, LogTag } from '../common/logging';
import { Base1Position, IPosition, Range } from '../common/positions';
import { findIndexAsync } from '../common/promiseUtil';
import { parseProgram, replace } from '../common/sourceCodeManipulations';
import { IRenameProvider, RenameMapping } from '../common/sourceMaps/renameProvider';
import { isInPatternSlot } from '../common/sourceUtils';
import { Source } from './source';
import { StackFrame } from './stackTrace';
import { getSourceSuffix } from './templates';
import { VariableStore } from './variableStore';

export const returnValueStr = '$returnValue';

const hoistedPrefix = '__js_debug_hoisted_';

const makeHoistedName = () => hoistedPrefix + randomBytes(8).toString('hex');

export const IEvaluator = Symbol('IEvaluator');

export type PreparedHoistFn = (
  variable: string,
) => Promise<Cdp.Runtime.RemoteObject | undefined> | Cdp.Runtime.RemoteObject | undefined;

/**
 * Prepared call that can be invoked later on a callframe..
 */
export type PreparedCallFrameExpr = (
  params: Omit<Cdp.Debugger.EvaluateOnCallFrameParams, 'expression'>,
  hoist?: PreparedHoistFn,
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

  /**
   * Optional information used to rename identifiers.
   */
  renames?: RenamePrepareOptions;
}

export type RenamePrepareOptions = { position: IPosition; mapping: RenameMapping };

export type LocationEvaluateOptions = {
  source: Source;
  position: IPosition;
  variables: VariableStore;
};

export interface IEvaluateOptions extends IEvaluatorBaseOptions {
  /**
   * Stack frame object on which the evaluation is being run. This is
   * necessary to allow for renamed properties.
   */
  stackFrame?: StackFrame;

  /**
   * A manually-provided source location for the evaluation, as an alternative
   * to {@link stackFrame}
   */
  location?: LocationEvaluateOptions;
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

  constructor(
    @inject(ICdpApi) private readonly cdp: Cdp.Api,
    @inject(IRenameProvider) private readonly renameProvider: IRenameProvider,
    @inject(ILogger) private readonly logger: ILogger,
  ) {}

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
    { isInternalScript, hoist, renames }: IPrepareOptions = {},
  ): { canEvaluateDirectly: boolean; invoke: PreparedCallFrameExpr } {
    if (isInternalScript !== false) {
      expression += getSourceSuffix();
    }

    // CDP gives us a way to evaluate a function in the context of a given
    // object ID. What we do to make returnValue work is to hoist the return
    // object onto `globalThis`, replace reference in the expression, then
    // evalute the expression and unhoist it from the globals.
    const toHoist = new Map<string, string>();
    toHoist.set(returnValueStr, makeHoistedName());
    for (const key of hoist ?? []) {
      toHoist.set(key, makeHoistedName());
    }

    let { transformed, hoisted } = this.replaceVariableInExpression(expression, toHoist, renames);
    if (!hoisted.size) {
      return {
        canEvaluateDirectly: true,
        invoke: params =>
          this.cdp.Debugger.evaluateOnCallFrame({ ...params, expression: transformed }),
      };
    }

    return {
      canEvaluateDirectly: false,
      invoke: (params, doHoist) =>
        Promise.all(
          [...toHoist].map(async ([ident, hoisted]) => {
            const ok = await this.hoistValue(
              ident === returnValueStr ? this.returnValue : await doHoist?.(ident),
              hoisted,
            );

            if (!ok) {
              // naive replace here since the identifier is a complex random
              // string and not likely to exist in the expression otherwise
              transformed = transformed.replaceAll(hoisted, ident);
            }
          }),
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
    options?: IEvaluateOptions,
  ): Promise<Cdp.Runtime.EvaluateResult>;
  public async evaluate(
    params: Cdp.Debugger.EvaluateOnCallFrameParams | Cdp.Runtime.EvaluateParams,
    options: IEvaluateOptions = {},
  ) {
    // no call frame means there will not be any relevant $returnValue to reference
    if (!('callFrameId' in params)) {
      return this.cdp.Runtime.evaluate(params);
    }

    const prepareOptions: IPrepareOptions | undefined = { ...options };
    const { location, stackFrame } = options;
    let hoist: PreparedHoistFn | undefined;
    if (location) {
      await Promise.all([
        // 1. Get the rename mapping at the desired position
        Promise.resolve(this.renameProvider.provideForSource(location.source)).then(mapping => {
          prepareOptions.renames = { mapping, position: location.position };
        }),
        // 2. Hoist variables that may be shadowed. Identify the scope containing
        // the location and mark any variables that appear in a higher scope
        // (and therefore could be shadowed) as hoistable.
        stackFrame
        && this.setupShadowedVariableHoisting(location, stackFrame).then(r => {
          if (r) {
            hoist = r.doHoist;
            prepareOptions.hoist = [...r.hoistable];
          }
        }),
      ]);
    } else if (stackFrame) {
      const mapping = await this.renameProvider.provideOnStackframe(stackFrame);
      prepareOptions.renames = { mapping, position: stackFrame.rawPosition };
    }

    return this.prepare(params.expression, prepareOptions).invoke(params, hoist);
  }

  /**
   * Hoists the return value of the expression to the `globalThis`.
   * Returns whether the hoisting was successful.
   */
  private async hoistValue(
    object: Cdp.Runtime.RemoteObject | undefined,
    hoistedVar: string,
  ): Promise<boolean> {
    if (object === undefined) {
      return false;
    }

    const objectId = object?.objectId;
    const dehoist = `setTimeout(() => { delete globalThis.${hoistedVar} }, 0)`;

    let r: Cdp.Runtime.CallFunctionOnResult | Cdp.Runtime.EvaluateResult | undefined;
    if (objectId) {
      r = await this.cdp.Runtime.callFunctionOn({
        objectId,
        functionDeclaration:
          `function() { globalThis.${hoistedVar} = this; ${dehoist}; ${getSourceSuffix()} }`,
      });
    } else {
      r = await this.cdp.Runtime.evaluate({
        expression: `globalThis.${hoistedVar} = ${JSON.stringify(object?.value)};`
          + `${dehoist};`
          + getSourceSuffix(),
      });
    }
    return !!r && !r.exceptionDetails;
  }

  /**
   * Returns shadowed variables at the given location in the stack's scopes
   * and a function that can be used to hoist the variables.
   *
   * It does this by identifying the scope the evaluation is being run in,
   * marking all variables found in scopes above it as hoistable, and
   * creating a function that will return the RemoteObject of a given
   * shadowed variable.
   */
  private async setupShadowedVariableHoisting(
    { position, source, variables }: LocationEvaluateOptions,
    stackFrame: StackFrame,
  ) {
    const { scopes } = await stackFrame.scopes();

    const scopeIndex = await findIndexAsync(
      scopes,
      async s =>
        s.source
        && s.line
        && s.endLine
        && new Range(
          new Base1Position(s.line, s.column || 1),
          new Base1Position(s.endLine, s.endColumn || Infinity),
        ).contains(position)
        && (await source.equalsDap(s.source)),
    );
    if (scopeIndex === -1) {
      return;
    }

    this.logger.verbose(
      LogTag.Runtime,
      `Evaluating expression in scope ${scopes[scopeIndex].name}`,
    );

    const hoistable = new Set<string>();
    await Promise.all(
      scopes.slice(0, scopeIndex).map(async s => {
        const vars = await variables.getVariableNames({
          variablesReference: s.variablesReference,
        });
        for (const { name } of vars) {
          hoistable.add(name);
        }
      }),
    );

    const doHoist: PreparedHoistFn = async variable => {
      for (let i = scopeIndex; i < scopes.length; i++) {
        const vars = await variables.getVariableNames({
          variablesReference: scopes[i].variablesReference,
        });
        return vars.find(v => v.name === variable)?.remoteObject;
      }
    };

    return { hoistable, doHoist };
  }

  /**
   * Replaces a variable in the given expression with the `hoisted` variable,
   * returning the identifiers which were hoisted.
   */
  private replaceVariableInExpression(
    expr: string,
    hoistMap: Map<string, /* identifier */ string /* hoised */>,
    renames: RenamePrepareOptions | undefined,
  ): { hoisted: Set<string>; transformed: string } {
    const hoisted = new Set<string>();
    let mutated = false;

    const replacement = (name: string, fallback: Expression): ConditionalExpression => ({
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
      alternate: fallback,
    });

    const parents: Node[] = [];
    const program = parseProgram(expr);
    const transformed = replace(program, {
      enter(node, parent) {
        const asAcorn = node as AcornNode;
        if (node.type !== 'Identifier' || expr[asAcorn.start - 1] === '.') {
          return;
        }

        const hoistName = hoistMap.get(node.name);
        if (hoistName) {
          hoisted.add(node.name);
          mutated = true;
          return {
            replace: isInPatternSlot(node, parent)
              ? { type: 'Identifier', name: hoistName }
              : replacement(hoistName, undefinedExpression),
          };
        }

        const cname = renames?.mapping.getCompiledName(node.name, renames.position);
        if (cname) {
          mutated = true;
          return {
            replace: isInPatternSlot(node, parent)
              ? { type: 'Identifier', name: cname }
              : replacement(cname, node),
          };
        }
      },
      leave: () => {
        parents.pop();
      },
    });

    if (!mutated) {
      return { hoisted, transformed: expr };
    }

    // preserve any trailing comment, which might be something like `sourceURL=...`
    // see https://github.com/microsoft/vscode-js-debug/issues/1259#issuecomment-1442584596
    const stmtsEnd = (program.body[program.body.length - 1] as AcornNode).end;
    return { hoisted, transformed: generate(transformed) + expr.slice(stmtsEnd) };
  }
}

const undefinedExpression: Expression = {
  type: 'Identifier',
  name: 'undefined',
};
