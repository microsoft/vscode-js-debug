/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Node, parseExpressionAt } from 'acorn';
import { randomBytes } from 'crypto';
import { Expression } from 'estree';
import Cdp from '../../cdp/api';
import { SourceConstants } from '../../common/sourceUtils';

/**
 * Gets the suffix containing the `sourceURL` to mark a script as internal.
 */
export const getSourceSuffix = () =>
  `\n//# sourceURL=eval-${randomBytes(4).toString('hex')}${SourceConstants.InternalExtension}\n`;

export type TemplateFunction<A extends unknown[]> = {
  expr: (...args: A) => string;
  decl: (...args: A) => string;
};

/**
 * Creates a template for the given function that replaces its arguments
 * and generates a string to be executed where it takes expressions to be
 * interpolated in place of arguments.  It assumes there's no shadowing
 * going on and that the template does not reference things outside its scope.
 *
 * This is not pretty, but presented as an alternative to writing a bunch of
 * raw JavaScript functions in strings.
 *
 * Example:
 *
 * ```js
 * const multiply = (a, b) => {
 *   return a * b;
 * };
 * const template = templateFunction(multiply);
 * console.log(multiple('42', 'foo()));
 * ```
 *
 * Outputs:
 *
 * ```
 * (() => {
 *   let __arg0 = 42;
 *   let __arg1 = foo();
 *   return __arg0 * __arg1;
 * })();
 * ```
 */
export function templateFunction<A>(fn: (a: A) => void): TemplateFunction<[string]>;
export function templateFunction<A, B>(
  fn: (a: A, b: B) => void,
): TemplateFunction<[string, string]>;
export function templateFunction<A, B, C>(
  fn: (a: A, b: B, c: C) => void,
): TemplateFunction<[string, string, string]>;
export function templateFunction<Args extends unknown[]>(fn: string): TemplateFunction<Args>;
export function templateFunction<Args extends unknown[]>(
  fn: string | ((...args: Args) => void),
): TemplateFunction<string[]> {
  return templateFunctionStr('' + fn);
}

function templateFunctionStr<Args extends string[]>(stringified: string): TemplateFunction<Args> {
  const decl = parseExpressionAt(stringified, 0, {
    ecmaVersion: 'latest',
    locations: true,
  }) as Expression;

  if (decl.type !== 'FunctionExpression') {
    throw new Error(`Could not find function declaration for:\n\n${stringified}`);
  }

  const params = decl.params.map(p => {
    if (p.type !== 'Identifier') {
      throw new Error('Parameter must be identifier');
    }

    return p.name;
  });

  const { start, end } = decl.body as unknown as Node;
  const inner = (args: string[]) => `
    ${args.map((a, i) => `let ${params[i]} = ${a}`).join('; ')};
    ${stringified.slice(start + 1, end - 1)}
  `;
  return {
    expr: (...args: Args) => `(()=>{${inner(args)}})();\n${getSourceSuffix()}`,
    decl: (...args: Args) => `function(...runtimeArgs){${inner(args)};\n${getSourceSuffix()}}`,
  };
}

/**
 * Exception thrown from the {@link remoteFunction} on an error.
 */
export class RemoteException extends Error {
  constructor(public readonly details: Cdp.Runtime.ExceptionDetails) {
    super(details.text);
  }
}

// We need to omit and then intersect the value type, otherwise
// R gets polluted by the `any`.
type RemoteObjectWithType<R, ByValue> = ByValue extends true
  ? Omit<Cdp.Runtime.RemoteObject, 'value'> & { value: R }
  : Omit<Cdp.Runtime.RemoteObject, 'value'> & { objectId: string };

/** Represets a CDP remote object that can be used as an argument to RemoteFunctions */
export class RemoteObjectId {
  constructor(public readonly objectId: string) {}
}

/**
 * Wraps the function such that it can be invoked over CDP. Returns a function
 * that takes the CDP and arguments with which to invoke the function. The
 * arguments should be simple objects.
 */
export function remoteFunction<Args extends unknown[], R>(fn: string | ((...args: Args) => R)) {
  let stringified = '' + fn;
  const endIndex = stringified.lastIndexOf('}');
  stringified = stringified.slice(0, endIndex) + getSourceSuffix() + stringified.slice(endIndex);

  // Some ugly typing here, but it gets us type safety. Mainly we want to:
  //  1. Have args that extend the function arg and omit the args we provide (easy)
  //  2. If and only if returnByValue is set to true, have that type in our return
  //  3. If and only if it's not set, then return an object ID.
  const result = async <ByValue extends boolean = false>({
    cdp,
    args,
    ...options
  }:
    & { cdp: Cdp.Api; args: Args | RemoteObjectId[] }
    & Omit<
      Cdp.Runtime.CallFunctionOnParams,
      'functionDeclaration' | 'arguments' | 'returnByValue'
    >
    & (ByValue extends true ? { returnByValue: ByValue } : {})
  ): Promise<
    RemoteObjectWithType<R, ByValue>
  > => {
    const result = await cdp.Runtime.callFunctionOn({
      functionDeclaration: stringified,
      arguments: args.map(value =>
        value instanceof RemoteObjectId ? { objectId: value.objectId } : { value }
      ),
      ...options,
    });

    if (!result) {
      throw new RemoteException({
        exceptionId: 0,
        text: 'No response from CDP',
        lineNumber: 0,
        columnNumber: 0,
      });
    }

    if (result.exceptionDetails) {
      throw new RemoteException(result.exceptionDetails);
    }

    return result.result as RemoteObjectWithType<R, ByValue>;
  };

  result.source = stringified;

  return result;
}
