/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as ts from 'typescript';
import { invalidBreakPointCondition } from '../../../dap/errors';
import { ProtocolError } from '../../../dap/protocolError';
import { ILogger } from '../../../common/logging';
import { IBreakpointCondition } from '.';
import { SimpleCondition } from './simple';
import { createHash } from 'crypto';
import { getSyntaxErrorIn } from '../../../common/sourceUtils';
import Dap from '../../../dap/api';
import { injectable, inject } from 'inversify';
import { IEvaluator } from '../../evaluator';
import { RuntimeLogPoint } from './runtimeLogPoint';
import { returnErrorsFromStatements } from '../../../common/sourceCodeManipulations';

/**
 * Compiles log point expressions to breakpoints.
 */
@injectable()
export class LogPointCompiler {
  constructor(
    @inject(ILogger) private readonly logger: ILogger,
    @inject(IEvaluator) private readonly evaluator: IEvaluator,
  ) {}

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

  private serializeLogStatements(statements: ReadonlyArray<ts.Statement>) {
    return returnErrorsFromStatements('', statements, false);
  }

  /**
   * Converts the log message in the form of `hello {name}!` to an expression
   * like `console.log('hello %O!', name);` (with some extra wrapping). This is
   * used to implement logpoint breakpoints.
   */
  private logMessageToExpression(msg: string) {
    const unescape = (str: string) => str.replace(/%/g, '%%');
    const formatParts = [];
    const args = [];

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

      const sourceFile = ts.createSourceFile(
        'file.js',
        msg.slice(start),
        ts.ScriptTarget.ESNext,
        true,
      );

      const firstBlock = sourceFile.statements[0];
      end = start + firstBlock.end;

      // unclosed or empty bracket is not valid, emit it as text
      if (end - 1 === start + 1 || msg[end - 1] !== '}') {
        formatParts.push(unescape(msg.slice(start, end)));
        continue;
      }

      if (
        !this.logger.assert(
          ts.isBlock(firstBlock),
          'Expected first statement in logpoint to be block',
        )
      ) {
        break;
      }

      args.push(this.serializeLogStatements((firstBlock as ts.Block).statements));
      formatParts.push('%O');
    }

    const result = `console.log(${[JSON.stringify(formatParts.join('')), ...args].join(', ')})`;
    const hash = createHash('sha1').update(result).digest('hex').slice(0, 7);

    return result + `\n//# sourceURL=logpoint-${hash}.cdp`;
  }
}
