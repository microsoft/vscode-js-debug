// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { TestP } from '../test';
import Dap from '../../dap/api';

export async function logVariable(variable: Dap.Variable, p: TestP, indent?: string) {
  indent = indent || '';
  const namedCount = variable.namedVariables ? `{${variable.namedVariables}}` : '';
  const indexedCount = variable.namedVariables ? `[${variable.indexedVariables}]` : '';
  p.log(`${indent}${variable.name}${namedCount}${indexedCount}: ${variable.type} = ${variable.value}`);
  if (variable.variablesReference) {
    const result = await p.dap.variables({ variablesReference: variable.variablesReference });
    for (const variable of result.variables)
      logVariable(variable, p, indent + '  ');
  }
}

