/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { TestP } from '../test';
import Dap from '../../dap/api';

export async function logVariable(variable: Dap.Variable, p: TestP, depth: number = 2, indent?: string) {
  if (!depth)
    return;
  indent = indent || '';
  const name = variable.name || '<empty>';
  const type = variable.type ? `: ${variable.type}` : '';
  const value = variable.value ? ` = ${variable.value}` : '';
  const namedCount = variable.namedVariables ? `{${variable.namedVariables}}` : '';
  const indexedCount = variable.indexedVariables ? `[${variable.indexedVariables}]` : '';

  p.log(`${indent}${name}${namedCount}${indexedCount}${type}${value}`);
  if (variable.variablesReference) {
    const result = await p.dap.variables({ variablesReference: variable.variablesReference });
    for (const variable of result.variables)
      await logVariable(variable, p, depth - 1, indent + '    ');
  }
}

