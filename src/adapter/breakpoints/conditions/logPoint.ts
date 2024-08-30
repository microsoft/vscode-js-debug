/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { generate } from 'astring';
import { createHash } from 'crypto';
import { Statement } from 'estree';
import { inject, injectable } from 'inversify';
import { parseSource, returnErrorsFromStatements } from '../../../common/sourceCodeManipulations';
import { getSyntaxErrorIn } from '../../../common/sourceUtils';
import Dap from '../../../dap/api';
import { invalidBreakPointCondition } from '../../../dap/errors';
import { ProtocolError } from '../../../dap/protocolError';
import { IEvaluator } from '../../evaluator';
import { IBreakpointCondition } from '.';
import { RuntimeLogPoint } from './runtimeLogPoint';
import { SimpleCondition } from './simple';

/**
 * Compiles log point expressions to breakpoints.
 */
@injectable()
export class LogPointCompiler {
  constructor(@inject(IEvaluator) private readonly evaluator: IEvaluator) {}

  /**
   * Compiles the log point to an IBreakpointCondition.
   * @throws {ProtocolError} if the expression is invalid
   */
  public compile(params: Dap.SourceBreakpoint, logMessage: string): IBreakpointCondition {
    const expression = this.logMessageToExpression(logMessage);
    const err = getSyntaxErrorIn(expression);
    if (err) {
      throw new ProtocolError(invalidBreakPointCondition(params, err.message));
    }

    const { canEvaluateDirectly, invoke } = this.evaluator.prepare(expression);
    if (canEvaluateDirectly) {
      return new SimpleCondition(params, this.logMessageToExpression(logMessage));
    }

    return new RuntimeLogPoint(invoke);
  }

  private serializeLogStatements(statements: ReadonlyArray<Statement>) {
    return returnErrorsFromStatements([], statements, false);
  }

  /**
   * Converts the log message in the form of `hello {name}!` to an expression
   * like `console.log('hello %O!', name);` (with some extra wrapping). This is
   * used to implement logpoint breakpoints.
   */
  private logMessageToExpression(msg: string) {
    const unescape = (str: string) => str.replace(/%/g, '%%');
    const formatParts = [];
    const args: string[] = [];

    let end = 0;

    // Parse each interpolated {code} in the message as a TS program. TS will
    // parse the first {code} as a "Block", the first statement in the program.
    // We want to reach to the end of that block and evaluate any code therein.
    while (true) {
      const start = msg.indexOf('{', end);
      if (start === -1) {
        formatParts.push(unescape(msg.slice(end)));
        break;
      }

      formatParts.push(unescape(msg.slice(end, start)));

      const [block] = parseSource(msg.slice(start));
      end = start + block.end;

      // unclosed or empty bracket is not valid, emit it as text
      if (end - 1 === start + 1 || msg[end - 1] !== '}') {
        formatParts.push(unescape(msg.slice(start, end)));
        continue;
      }

      if (block.type !== 'BlockStatement') {
        break;
      }

      // tranform property shortand `{{foo}}` to `{({foo})}`, reparse:
      if (block.body.length === 1 && block.body[0].type === 'BlockStatement') {
        block.body = parseSource(`(${msg.slice(start + 1, end - 2)}})`);
      }

      args.push(generate(this.serializeLogStatements(block.body)));
      formatParts.push('%O');
    }

    const evalArgs = [JSON.stringify(formatParts.join('')), ...args].join(', ');
    const result = `console.log(${evalArgs}), false`; // false for #1191
    const hash = createHash('sha256').update(result).digest('hex').slice(0, 7);

    return result + `\n//# sourceURL=logpoint-${hash}.cdp`;
  }
}
