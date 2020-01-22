/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as ts from 'typescript';
import { assert, logger } from '../../common/logging/logger';
import { invalidLogPointSyntax } from '../../dap/errors';
import { LogTag } from '../../common/logging';

function getSyntaxErrorIn(code: string): Error | void {
  try {
    new Function(code);
  } catch (e) {
    return e;
  }
}

function serializeLogStatements(statements: ReadonlyArray<ts.Statement>) {
  let output = `(() => {
    try {`;
  for (let i = 0; i < statements.length; i++) {
    let stmt = statements[i].getText().trim();
    if (!stmt.endsWith(';')) {
      stmt += ';';
    }

    if (i === statements.length - 1) {
      const returned = `return ${stmt}`;
      if (!getSyntaxErrorIn(returned)) {
        output += returned;
        break;
      }
    }

    output += stmt;
  }

  const result = `${output}
    } catch (e) {
      return e.stack || e.message || String(e);
    }
  })()`;

  const error = getSyntaxErrorIn(result);
  if (error) {
    logger.warn(LogTag.Runtime, 'Error parsing logpoint BP', {
      code: result,
      input: statements[0].getSourceFile().getText(),
    });

    // todo(connor4312): this doesn't actually get handled in VS Code, but once it
    // does it should 'just work': https://github.com/microsoft/vscode/issues/89059
    throw invalidLogPointSyntax(error.message);
  }

  return result;
}

/**
 * Converts the log message in the form of `hello {name}!` to an expression
 * like `console.log('hello %O!', name);` (with some extra wrapping). This is
 * used to implement logpoint breakpoints.
 */
export function logMessageToExpression(msg: string) {
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

    if (!assert(ts.isBlock(firstBlock), 'Expected first statement in logpoint to be block')) {
      break;
    }

    args.push(serializeLogStatements((firstBlock as ts.Block).statements));
    formatParts.push('%O');
  }

  return `console.log(${[JSON.stringify(formatParts.join('')), ...args].join(', ')})`;
}
