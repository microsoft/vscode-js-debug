// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { TestP } from '../test';
import Dap from '../../dap/api';

export async function logVariable(p: TestP, variable: Dap.Variable, depth: number = 2, indent?: string) {
  if (!depth)
    return;
  indent = indent || '';
  const name = variable.name ? `${variable.name}: ` : '';
  const value = variable.value || '';
  const type = variable.type ? `type=${variable.type}` : '';
  const namedCount = variable.namedVariables ? ` named=${variable.namedVariables}` : '';
  const indexedCount = variable.indexedVariables ? ` indexed=${variable.indexedVariables}` : '';

  let suffix = `${type}${namedCount}${indexedCount}`;
  if (suffix)
    suffix = '  // ' + suffix;
  const line = `${name}${value}${suffix}`;
  if (line)
    p.log(`${indent}${line}`);
  if (variable.variablesReference) {
    const result = await p.dap.variables({ variablesReference: variable.variablesReference });
    for (const variable of result.variables)
      await logVariable(p, variable, depth - 1, indent + '    ');
  }
}

export async function logOutput(p: TestP, params: Dap.OutputEventParams) {
  const prefix = `${params.category}> `;
  if (params.output)
    p.log(`${prefix}${params.output}`);
  if (params.variablesReference) {
    const result = await p.dap.variables({ variablesReference: params.variablesReference });
    for (const variable of result.variables)
      await logVariable(p, variable, 2, prefix);
  }
}
