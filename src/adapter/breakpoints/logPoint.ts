/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as ts from 'typescript';
import { assert, logger } from '../../common/logging/logger';
import { invalidLogPointSyntax } from '../../dap/errors';
import { LogTag } from '../../common/logging';
/**
 * Statments which we should not prefix with `return {}`
 */
const unreturnable: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.ReturnStatement,
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ContinueStatement,
  ts.SyntaxKind.BreakStatement,
  ts.SyntaxKind.ReturnStatement,
  ts.SyntaxKind.WithStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.LabeledStatement,
  ts.SyntaxKind.TryStatement,
  ts.SyntaxKind.ThrowStatement,
  ts.SyntaxKind.DebuggerStatement,
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.VariableDeclarationList,
]);

function serializeLogStatements(statements: ReadonlyArray<ts.Statement>) {
  let output = `(() => {
    try {`;
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    if (i === statements.length - 1 && !unreturnable.has(stmt.kind)) {
      output += `return `;
    }

    output += stmt.getText().trim() + ';';
  }

  const result = `${output}
    } catch (e) {
      return e.stack || e.message || String(e);
    }
  })()`;

  // Make sure it's good syntax. This won't actually
  // run the user script, just ask V8 to parse it.
  try {
    new Function(result);
  } catch (e) {
    logger.warn(LogTag.Runtime, 'Error parsing logpoint BP', {
      code: result,
      input: statements[0].getSourceFile().getText(),
    });

    // todo(connor4312): this doesn't actually get handled in VS Code, but once it
    // does it should 'just work': https://github.com/microsoft/vscode/issues/89059
    throw invalidLogPointSyntax(e.message);
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
