/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { TestP } from '../test';
import Dap from '../../dap/api';

export async function logVariable(variable: Dap.Variable, p: TestP, depth: number = 2, indent?: string) {
  if (!depth)
    return;
  indent = indent || '';
  const namedCount = variable.namedVariables ? `{${variable.namedVariables}}` : '';
  const indexedCount = variable.namedVariables ? `[${variable.indexedVariables}]` : '';
  p.log(`${indent}${variable.name}${namedCount}${indexedCount}: ${variable.type} = ${variable.value}`);
  if (variable.variablesReference) {
    const result = await p.dap.variables({ variablesReference: variable.variablesReference });
    for (const variable of result.variables)
      await logVariable(variable, p, depth - 1, indent + '    ');
  }
}

