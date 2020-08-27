/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { getSyntaxErrorIn } from './sourceUtils';
import { invalidLogPointSyntax } from '../dap/errors';
import { ProtocolError } from '../dap/protocolError';
import ts from 'typescript';

/**
 * function (params) { code } => function (params) { catchAndReturnErrors(code) }
 * statement => function () { return catchAndReturnErrors(return statement) }
 * statement; statement => function () { catchAndReturnErrors(statement; return statement;) }
 * */
export function codeToFunctionReturningErrors(
  parameterNames: string,
  statements: ReadonlyArray<ts.Statement>,
) {
  if (statements.length === 1 && statements[0].kind === ts.SyntaxKind.FunctionDeclaration) {
    const functionDeclarationCode = statements[0].getText();
    const callFunctionCode = `return (${functionDeclarationCode}).call(this, ${parameterNames});`;
    return codeToFunctionExecutingCodeAndReturningErrors(parameterNames, callFunctionCode, true);
  } else {
    return statementToFunctionReturningErrors(parameterNames, statements, true);
  }
}

/**
 * code => (parameterNames) => return catchAndReturnErrors(code)
 * */
function codeToFunctionExecutingCodeAndReturningErrors(
  parameterNames: string,
  code: string,
  preserveThis: boolean,
): string {
  return (
    (preserveThis ? `function _generatedCode(${parameterNames}) ` : `(${parameterNames}) => `) +
    `{
  try {
${code}
  } catch (e) {
    return e.stack || e.message || String(e);
  }
}`
  );
}

/**
 * function (params) { code } => (function (params) { code })(argumentsText)
 * */
export function functionToFunctionCall(argumentsText: string, functionCode: string): string {
  return `(${functionCode})(${argumentsText})`;
}

/**
 * statement => catchAndReturnErrors(return statement);
 * statement; statement => catchAndReturnErrors(statement; return statement);
 * */
export function returnErrorsFromStatements(
  parameterNames: string,
  statements: ReadonlyArray<ts.Statement>,
  preserveThis: boolean,
) {
  return functionToFunctionCall(
    parameterNames,
    statementToFunctionReturningErrors(parameterNames, statements, preserveThis),
  );
}

/**
 * statement => function () { catchAndReturnErrors(return statement); }
 * statement; statement => function () { catchAndReturnErrors(statement; return statement); }
 * */
export function statementToFunctionReturningErrors(
  parameterNames: string,
  statements: ReadonlyArray<ts.Statement>,
  preserveThis: boolean,
) {
  const output = [];

  for (let i = 0; i < statements.length; i++) {
    let stmt = statements[i].getText().trim();
    if (!stmt.endsWith(';')) {
      stmt += ';';
    }

    if (i === statements.length - 1) {
      const returned = `return ${stmt}`;
      if (!getSyntaxErrorIn(returned)) {
        output.push(`    ${returned}`);
        break;
      }
    }

    output.push(`    ${stmt}`);
  }

  const result = codeToFunctionExecutingCodeAndReturningErrors(
    parameterNames,
    output.join('\n'),
    preserveThis,
  );
  const error = getSyntaxErrorIn(result);
  if (error) {
    throw new ProtocolError(invalidLogPointSyntax(error.message));
  }

  return result;
}
